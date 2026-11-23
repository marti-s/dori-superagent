/** herdr-core (`hc`) is the only session runtime; the kind stays on every ref so a stored record names what it ran on. */
export type RuntimeKind = "hc";
/** One session as its runtime addresses it: the hc terminal address, and the `dori.group` label it was listed under. */
export type SessionRef = {
  readonly runtime: RuntimeKind;
  readonly id: string;
  readonly group?: string;
};
export type AgentStatus = "idle" | "working" | "blocked" | "error" | "done" | "unknown" | "shell" | "gone";
export type AgentIdentity = { readonly agent?: string; readonly pgid?: number };
export type ForegroundProcess = { readonly name: string; readonly argv: readonly string[]; readonly pid?: number };
/** One snapshot: status, identity, foreground and discovery data together (deliver re-reads them). `rootPid`: the terminal's own pid. */
export type Probe = {
  readonly status: AgentStatus;
  readonly agent?: string;
  readonly pgid?: number;
  readonly rootPid?: number;
  readonly turn?: number;
  readonly title?: string;
  readonly cwd?: string;
  readonly shellInFront: boolean;
  readonly foreground?: readonly ForegroundProcess[];
};
export type SessionInfo = {
  readonly ref: SessionRef;
  readonly name?: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly status?: AgentStatus;
  readonly agent?: string;
};
export type SessionRole = "lead" | "duty" | "duty-loop" | "hourly-loop" | "lane";
/** One labelled terminal running the user's shell with `env` set; `group` becomes its `dori.group` label. */
export type CreateSpec = {
  readonly name: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly role: SessionRole;
  readonly group?: string;
};
export type DeliverWhen = "idle" | "working" | "any";
/** `when`: the status the text may be typed under (--if idle / --if working / none for "any"; "any" still never types into an `unknown` or `shell` session). `force`: type into a blocked agent (hc --force). */
export type DeliverOptions = { readonly when?: DeliverWhen; readonly force?: boolean };
export type DeliverOutcome =
  | { readonly kind: "delivered"; readonly turn?: number; readonly started?: boolean }
  | { readonly kind: "no-agent" }
  | { readonly kind: "not-ready"; readonly status: AgentStatus }
  | { readonly kind: "typed"; readonly into: AgentIdentity; readonly failure: unknown }
  | { readonly kind: "ambiguous"; readonly detail: string; readonly failure: unknown };
export type SubmitResult = "submitted" | "wait" | "changed";
export type Key = "enter" | "escape";
/** `unwrapped`: a line the terminal wrapped over several rows comes back as one line, not one line per row. */
export type ReadOptions = { readonly unwrapped?: boolean };
export interface SessionRuntime {
  readonly kind: RuntimeKind;
  /** The caller's own session from the runtime's env (HC_TERMINAL_ID), or undefined. */
  self(): SessionRef | undefined;
  /** A session with the user's shell in it and nothing started. */
  create(spec: CreateSpec): Promise<SessionRef>;
  /** `hc send <id> <command>` into the shell (no --if: a shell reports no status). */
  start(ref: SessionRef, command: string): Promise<void>;
  list(filter?: { readonly group?: string }): Promise<readonly SessionInfo[]>;
  probe(ref: SessionRef): Promise<Probe>;
  /** `hc read`; unwrapped joins rows as wide as the terminal's `cols`. */
  read(ref: SessionRef, lines: number, opts?: ReadOptions): Promise<string>;
  /** Never types into a session whose probe says shellInFront, whatever `status` says. Default `when` = "idle". */
  deliver(ref: SessionRef, text: string, opts?: DeliverOptions): Promise<DeliverOutcome>;
  submitTyped(ref: SessionRef, into: AgentIdentity): Promise<SubmitResult>;
  typeIntoShell(ref: SessionRef, text: string): Promise<boolean>;
  keys(ref: SessionRef, keys: readonly Key[]): Promise<void>;
  /** Ends the session and removes its record: `hc kill`, then `hc rm`. */
  close(ref: SessionRef): Promise<void>;
}

/** A local hc terminal address. hc numbers terminals in base 36 (`t7`, `t1b`, `t2h`); another machine's `<machine>/<address>` is not a ref. */
const HC_ADDRESS = /^t[0-9a-z]+$/;
const PREFIX = "hc:";

/**
 * "hc:t7" or a bare "t7"; undefined otherwise. A bare address is also a legal lane key, so a caller that takes both
 * tries the lane first (see resolveTarget).
 */
export const parseRef: (text: string) => SessionRef | undefined = (text) => {
  const id = text.startsWith(PREFIX) ? text.slice(PREFIX.length) : text;
  return HC_ADDRESS.test(id) ? { runtime: "hc", id } : undefined;
};
export const formatRef: (ref: SessionRef) => string = (ref) => `${ref.runtime}:${ref.id}`;
/**
 * create + start in one call (the root harness path). A start that fails closes the session create just made, so no
 * idle shell is left behind, and rethrows the start error; a close that fails too is one stderr line.
 */
export const openSession: (rt: SessionRuntime, spec: CreateSpec, command: string) => Promise<SessionRef> = async (
  rt,
  spec,
  command,
) => {
  const ref = await rt.create(spec);
  try {
    await rt.start(ref, command);
  } catch (e) {
    await rt.close(ref).catch((closeError: unknown) => {
      const why = closeError instanceof Error ? closeError.message : String(closeError);
      process.stderr.write(`dori: could not close ${formatRef(ref)} after its start failed (${why})\n`);
    });
    throw e;
  }
  return ref;
};
