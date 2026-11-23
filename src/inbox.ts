import { DeliveryUncertain, failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { resolveTarget } from "./target.ts";
import { refText } from "./refs.ts";
import type { AgentStatus, SessionRef } from "./runtime/types.ts";
import type { DeliveryAttempt, QueuedMessage } from "./store-types.ts";

// A session with no running agent (`shell`) is never ready: text typed into a bare shell runs as a command (#66).
// `error` waits like `blocked`: the agent needs a person before it reads anything.
const READY_TO_READ: readonly AgentStatus[] = ["idle", "done"];

export type SendResult = "DELIVERED" | "QUEUED" | "HELD";

/**
 * Delivers now when the pane can read; otherwise queues it for the duty loop (busy agents are never interrupted).
 * The command-line path: an uncertain delivery is a result, never an error (see settled).
 */
export async function send(d: Deps, target: string, text: string, from: string): Promise<SendResult> {
  return settled(sendOrThrow(d, target, text, from));
}

/** send for the duty and hourly loops: throws DeliveryUncertain, having recorded it, so they report the failure. */
export async function sendOrThrow(
  d: Deps,
  target: string,
  text: string,
  from: string,
): Promise<"DELIVERED" | "QUEUED"> {
  const ref = resolveTarget(d, target);
  d.store.enqueue(ref, { at: d.now(), from, text });
  return (await flushInbox(d, ref)) === "delivered" ? "DELIVERED" : "QUEUED";
}

/**
 * An uncertain delivery is already recorded on the queued message (#89), so on the command-line path it is a result:
 * a sender who saw a failure would send again. `HELD`: it may or may not have reached the pane and is not resent.
 * `QUEUED`: typed text that only waits for its Enter.
 */
export async function settled<T extends SendResult | undefined>(delivery: Promise<T>): Promise<T | "QUEUED" | "HELD"> {
  try {
    return await delivery;
  } catch (e) {
    if (e instanceof DeliveryUncertain) return e.typed ? "QUEUED" : "HELD";
    throw e;
  }
}

/** The lead delivery's result, or undefined when no lead is registered. Throws DeliveryUncertain like sendOrThrow. */
export async function tellLead(d: Deps, text: string, from: string): Promise<"DELIVERED" | "QUEUED" | undefined> {
  if (!d.store.roles().lead) {
    process.stderr.write(`dori: no lead pane registered; message kept only in the lane log\n`);
    return undefined;
  }
  return sendOrThrow(d, "lead", text, from);
}

/**
 * Delivers a session's queued messages as one batch. `held`: only messages held after an ambiguous delivery are left;
 * they wait for a person or the lead (#89). `queued` also when another flush of this session holds its inbox lock: one
 * flush per session at a time, across processes (#108). Throws DeliveryUncertain, having recorded the attempt on the
 * queued messages, when the batch may already have reached the session, and Refusal when the session is gone.
 */
export async function flushInbox(d: Deps, ref: SessionRef): Promise<"delivered" | "queued" | "no-agent" | "held"> {
  if (d.store.queued(ref).length === 0) return "delivered";
  const release = d.store.lockInbox(ref, d.now());
  if (!release) return "queued";
  try {
    return await flushLocked(d, ref);
  } finally {
    release();
  }
}

async function flushLocked(d: Deps, ref: SessionRef): Promise<"delivered" | "queued" | "no-agent" | "held"> {
  // Re-read under the lock: the flush that held it may have delivered these meanwhile.
  const all = d.store.queued(ref);
  if (all.length === 0) return "delivered";
  const queued = all.filter((m) => m.attempt?.state !== "ambiguous");
  const rt = d.runtimes.for(ref);
  // The probe carries the #62 screen check: an omo with live monitors between turns reads idle.
  const { status } = await rt.probe(ref);
  // Before the held check, so a gone session with only held messages says so instead of delivery-ambiguous forever (#108).
  if (status === "gone") throw new Refusal(`pane ${refText(ref)} is gone; ${all.length} message(s) kept in its inbox`);
  if (queued.length === 0) return "held";
  const typed = queued.filter((m) => m.attempt?.state === "typed");
  if (status === "shell") {
    // The agent the text was typed into is gone from the session: an Enter later would go to another agent's empty input.
    if (typed.length > 0) await holdTyped(d, ref, typed, "the agent left the pane before its Enter");
    return "no-agent";
  }
  if (!READY_TO_READ.includes(status)) return "queued";
  const first = typed[0];
  if (first !== undefined) {
    // An earlier pass typed these and only the Enter failed: press Enter, never type them again (#89), and only into
    // the agent they were typed into (#108).
    const into = {
      ...(first.attempt?.agent !== undefined ? { agent: first.attempt.agent } : {}),
      ...(first.attempt?.pgid !== undefined ? { pgid: first.attempt.pgid } : {}),
    };
    let submitted: Awaited<ReturnType<typeof rt.submitTyped>>;
    try {
      submitted = await rt.submitTyped(ref, into);
    } catch (e) {
      throw new DeliveryUncertain(e, true, into);
    }
    if (submitted === "wait") return "no-agent";
    if (submitted === "changed") {
      await holdTyped(d, ref, typed, "a different agent is in the pane than the one the text was typed into");
      return typed.length === queued.length ? "held" : "queued";
    }
    settleInbox(d, ref, typed);
    // Messages queued after the typed batch were not delivered by this Enter; they wait for the next pass.
    return typed.length === queued.length ? "delivered" : "queued";
  }
  const body =
    queued.length === 1
      ? (queued[0]?.text ?? "")
      : `${queued.length} messages arrived while you were busy:\n\n` +
        queued.map((m, i) => `(${i + 1}) from ${m.from}:\n${m.text}`).join("\n\n");
  const out = await rt.deliver(ref, body);
  switch (out.kind) {
    case "delivered":
      settleInbox(d, ref, queued);
      return "delivered";
    case "no-agent":
      return "no-agent";
    case "not-ready":
      return "queued";
    case "typed":
    case "ambiguous": {
      const e =
        out.kind === "typed"
          ? new DeliveryUncertain(out.failure, true, out.into)
          : new DeliveryUncertain(out.failure, false);
      await recordUncertain(d, ref, queued, e, rt.kind);
      throw e;
    }
  }
}

/** Re-reads the inbox and drops the batch (delivered) or marks it with the failed attempt; messages queued meanwhile stay. */
function settleInbox(d: Deps, ref: SessionRef, batch: readonly QueuedMessage[], attempt?: DeliveryAttempt): void {
  const left = [...batch];
  const rest = d.store.queued(ref).flatMap((m) => {
    const i = left.findIndex((b) => b.at === m.at && b.from === m.from && b.text === m.text);
    if (i < 0) return [m];
    left.splice(i, 1);
    return attempt ? [{ ...m, attempt }] : [];
  });
  d.store.saveInbox(ref, rest);
}

const NOTICE_FROM = "dori-delivery";

/**
 * Records an uncertain delivery on the queued messages. Typed text only waits for its Enter. An ambiguous batch is
 * held and the lead is told once; held messages are never retried, so the notice is never repeated. A notice that
 * itself fails ambiguously is held without another notice, so this cannot loop.
 */
async function recordUncertain(
  d: Deps,
  ref: SessionRef,
  batch: readonly QueuedMessage[],
  e: DeliveryUncertain,
  runtime: string,
): Promise<void> {
  const detail = failureDetail(e);
  settleInbox(d, ref, batch, {
    at: d.now(),
    state: e.typed ? "typed" : "ambiguous",
    detail,
    ...(e.typed ? e.agent : {}),
  });
  if (!e.typed) await noticeHeld(d, ref, batch, `${runtime} said: ${detail}`);
}

/** Typed text whose agent left or changed (#108): it may sit in a lost input, so it is held like an ambiguous batch. */
async function holdTyped(d: Deps, ref: SessionRef, typed: readonly QueuedMessage[], why: string): Promise<void> {
  settleInbox(d, ref, typed, { at: d.now(), state: "ambiguous", detail: why });
  await noticeHeld(d, ref, typed, why);
}

async function noticeHeld(d: Deps, ref: SessionRef, batch: readonly QueuedMessage[], why: string): Promise<void> {
  if (batch.every((m) => m.from === NOTICE_FROM)) return;
  const paneId = refText(ref);
  const which = batch.map((m) => `from ${m.from} queued ${new Date(m.at).toISOString()}`).join(", ");
  const text =
    `[DELIVERY-AMBIGUOUS ${paneId}] ${batch.length} message(s) (${which}) may or may not have reached the pane; ${why}. ` +
    `Held and not resent. Check the pane and see dori inbox list ${paneId}: if it did not arrive, dori inbox resend ${paneId} <index>; if it did, dori inbox ack ${paneId} <index>.`;
  try {
    await tellLead(d, text, NOTICE_FROM);
  } catch (err) {
    process.stderr.write(
      `dori: telling the lead about the ambiguous delivery to ${paneId} failed too (${failureDetail(err)}); the notice is kept in the lead's inbox\n`,
    );
  }
}
