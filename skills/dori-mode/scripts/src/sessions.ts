// Sessions across every runtime the skill talks to: one `Runtimes` registry, each stored ref answered by its own kind.
import type { Runtimes } from "../../../../src/runtime/registry.ts";
import { type DeliverWhen, formatRef, type SessionInfo, type SessionRef } from "../../../../src/runtime/types.ts";
import type { Clock } from "./run.ts";

export class UnsafeTextError extends Error {}

/** Lines read when the caller asks for the screen without a count (about one visible screen). */
const SCREEN_LINES = 60;

/**
 * Every session of every runtime in use: the selected kind, each kind a registered lane lives on, and any kind built
 * so far. `group` keeps only the sessions of that group (a herdr workspace, an hc `dori.group` label).
 */
export const listSessions = async (
  rts: Runtimes,
  options: { readonly group?: string; readonly lanes?: readonly { readonly sessionRef?: SessionRef }[] } = {},
): Promise<SessionInfo[]> => {
  for (const lane of options.lanes ?? []) if (lane.sessionRef) rts.for(lane.sessionRef);
  // The selected kind is read last: a failed choice still lists every stored lane, and fails only when nothing else is.
  try {
    void rts.default;
  } catch (e) {
    if (rts.kinds().length === 0) throw e;
  }
  const out: SessionInfo[] = [];
  for (const kind of rts.kinds()) {
    const rt = rts.for({ runtime: kind, id: "" });
    out.push(...(await rt.list(options.group === undefined ? undefined : { group: options.group })));
  }
  return out;
};

/**
 * The sessions of the watched groups, each group listed by name; every session when none is watched. hc names a
 * session's group only when it is asked for that group (its `dori.group` label), so listing everything and filtering
 * by `ref.group` would drop every hc session (#196); herdr lists by workspace either way. A session is kept once.
 */
export const listWatched = async (
  rts: Runtimes,
  groups: readonly string[],
  lanes?: readonly { readonly sessionRef?: SessionRef }[],
): Promise<SessionInfo[]> => {
  if (groups.length === 0) return listSessions(rts, lanes ? { lanes } : {});
  const out = new Map<string, SessionInfo>();
  for (const group of new Set(groups))
    for (const s of await listSessions(rts, lanes ? { group, lanes } : { group })) out.set(formatRef(s.ref), s);
  return [...out.values()];
};

export const readScreen = async (rts: Runtimes, ref: SessionRef, lines?: number): Promise<string> =>
  rts.for(ref).read(ref, lines ?? SCREEN_LINES);

/** States a runtime reports for a session whose agent is running. A screen read never stands in for these. */
export const ALIVE_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done", "error"]);

/** The agent's status word as the runtime lists it; undefined when the session runs no agent or is gone. */
export const agentStatus = async (rts: Runtimes, ref: SessionRef): Promise<string | undefined> => {
  const status = (await rts.for(ref).list()).find((s) => s.ref.id === ref.id)?.status;
  return status === "shell" || status === "gone" ? undefined : status;
};

/** Like agentStatus, but a failed lookup comes back as its error text instead of being swallowed. */
export const statusLookup = async (
  rts: Runtimes,
  ref: SessionRef,
): Promise<{ readonly status?: string; readonly error?: string }> => {
  try {
    const status = await agentStatus(rts, ref);
    return status !== undefined ? { status } : {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * True when an interactive shell is in the session's foreground (a suspended agent leaves its shell in front while the
 * runtime may still report it idle, #66), or when that cannot be read: doubt holds the send.
 */
export const shellInFront = async (rts: Runtimes, ref: SessionRef): Promise<boolean> => {
  try {
    return (await rts.for(ref).probe(ref)).shellInFront;
  } catch (e) {
    console.error(
      `shellInFront ${ref.id}: probe failed (${e instanceof Error ? e.message : String(e)}); holding the send`,
    );
    return true;
  }
};

export type Delivery = "delivered" | "unconfirmed" | "failed";

/**
 * Delivers the text once through the session's runtime. Delivery is confirmed only by a state change: the agent's
 * status moving to "working" from something else. A session that was already working cannot show that change, so its
 * send comes back "unconfirmed" and the caller decides. `when` defaults to the status read before the send, so a
 * runtime that compares and sends atomically refuses if the agent changed in between. Nothing is ever sent twice.
 */
export const sendVerified = async (
  rts: Runtimes,
  clock: Clock,
  ref: SessionRef,
  text: string,
  when?: DeliverWhen,
): Promise<Delivery> => {
  if (/`|\$\(/.test(text)) throw new UnsafeTextError("refusing to send text containing a backtick or $(");
  const before = await statusLookup(rts, ref);
  if (before.error) console.error(`sendVerified ${ref.id}: status lookup failed before send: ${before.error}`);
  // No running agent means a bare shell, where typed text runs as a command (#66). A failed lookup is doubt: refuse.
  if (before.status === undefined || !ALIVE_STATUSES.has(before.status)) return "failed";
  const outcome = await rts
    .for(ref)
    .deliver(ref, text, { when: when ?? (before.status === "working" ? "working" : "idle") });
  if (outcome.kind === "no-agent" || outcome.kind === "not-ready") return "failed";
  if (outcome.kind === "ambiguous") {
    // The text may already be there: report it and let the caller decide, never send it again.
    console.error(`sendVerified ${ref.id}: delivery ambiguous: ${outcome.detail}`);
    return "unconfirmed";
  }
  if (outcome.kind === "typed") console.error(`sendVerified ${ref.id}: text typed but Enter failed`);
  if (before.status === "working") return "unconfirmed";
  for (let attempt = 0; attempt < 6; attempt++) {
    await clock.sleep(700);
    const after = await statusLookup(rts, ref);
    if (after.error) console.error(`sendVerified ${ref.id}: status lookup failed: ${after.error}`);
    if (after.status === "working") return "delivered";
  }
  return "unconfirmed";
};
