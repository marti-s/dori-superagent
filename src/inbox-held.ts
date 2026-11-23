import type { Deps } from "./harness.ts";
import { send, type SendResult } from "./inbox.ts";
import { refText } from "./refs.ts";
import { Refusal } from "./refusal.ts";
import { resolveTarget } from "./target.ts";

/**
 * `dori send --to-shell`: the operator's per-message opt-in to type this one message into a pane with no agent.
 * Only the CLI flag reaches here, never relayed content, and queued messages are never typed with it. If an agent
 * is in the pane, or appears before typing, the message takes the queued agent path instead.
 */
export async function sendToShell(d: Deps, target: string, text: string, from: string): Promise<SendResult> {
  const ref = resolveTarget(d, target);
  const rt = d.runtimes.for(ref);
  if ((await rt.probe(ref)).status !== "shell") return send(d, target, text, from);
  if (await rt.typeIntoShell(ref, text)) return "DELIVERED";
  d.store.enqueue(ref, { at: d.now(), from, text });
  return "QUEUED";
}

// Held entries (#108).

export type InboxEntry = {
  index: number;
  state: "queued" | "typed" | "held";
  from: string;
  at: number;
  preview: string;
};

const PREVIEW_CHARS = 60;

/** A session's queued messages, 1-based in inbox order. The text is never shown whole: its first 60 characters, JSON-escaped. */
export function inboxList(d: Deps, target: string): { paneId: string; entries: InboxEntry[] } {
  const ref = resolveTarget(d, target);
  const entries = d.store.queued(ref).map(
    (m, i): InboxEntry => ({
      index: i + 1,
      state: m.attempt?.state === "ambiguous" ? "held" : m.attempt?.state === "typed" ? "typed" : "queued",
      from: m.from,
      at: m.at,
      preview: JSON.stringify(m.text.slice(0, PREVIEW_CHARS)) + (m.text.length > PREVIEW_CHARS ? "..." : ""),
    }),
  );
  return { paneId: refText(ref), entries };
}

/**
 * `ack` drops a held entry (it did arrive); `resend` clears its attempt so the next flush delivers it (it did not).
 * Only held entries: a typed one is in the session's input already, and a queued one is delivered anyway. Runs under
 * the inbox lock, so a flush in progress cannot overwrite the change. Returns the session as refText.
 */
export function releaseHeld(d: Deps, target: string, index: number, how: "ack" | "resend"): string {
  const ref = resolveTarget(d, target);
  const paneId = refText(ref);
  const release = d.store.lockInbox(ref, d.now());
  if (!release) throw new Refusal(`the inbox of ${paneId} is being flushed right now; try again`);
  try {
    const msgs = d.store.queued(ref);
    const m = Number.isInteger(index) ? msgs[index - 1] : undefined;
    if (!m)
      throw new Refusal(
        `no entry ${index} in the inbox of ${paneId} (${msgs.length} entries; see dori inbox list ${target})`,
      );
    if (m.attempt?.state !== "ambiguous")
      throw new Refusal(`entry ${index} of ${paneId} is not held; only held entries can be acked or resent`);
    const { attempt: _, ...fresh } = m;
    d.store.saveInbox(
      ref,
      how === "ack" ? msgs.filter((_, i) => i !== index - 1) : msgs.map((x, i) => (i === index - 1 ? fresh : x)),
    );
    return paneId;
  } finally {
    release();
  }
}
