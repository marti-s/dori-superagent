export type RuntimeKind = "herdr" | "hc";
/** One session as its runtime addresses it. `group`: the herdr workspace id or the hc dori.group label. `container`: the herdr tab id (absent on hc). */
export type SessionRef = {
  readonly runtime: RuntimeKind;
  readonly id: string;
  readonly group?: string;
  readonly container?: string;
};
export type AgentStatus = "idle" | "working" | "blocked" | "error" | "done" | "unknown" | "shell" | "gone";
export type AgentIdentity = { readonly agent?: string; readonly pgid?: number };
export type ForegroundProcess = { readonly name: string; readonly argv: readonly string[]; readonly pid?: number };
/** One snapshot: status, identity, foreground and discovery data together (submitTyped compares all of them; deliver re-reads them). `rootPid`: the session's root process (herdr process_info.shell_pid, hc terminal pid). */
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
/**
 * Where the session is created. herdr: "workspace-root" = `workspace create` (the root pane is the session; the new workspace id
 * becomes the ref's group); "tab" = `tab create` in `group` (no --workspace when group is absent); "split-below" = `pane split`
 * below `near`. hc ignores the container kind: one labelled terminal running the user's shell with `env` set.
 */
export type CreateSpec = {
  readonly name: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly role: SessionRole;
  readonly container: "workspace-root" | "tab" | "split-below";
  readonly group?: string;
  readonly near?: SessionRef;
};
export type DeliverWhen = "idle" | "working" | "any";
/** `when`: the status the text may be typed under (hc: --if idle / --if working / none for "any"; "any" still never types into an `unknown` or `shell` session). `force`: type into a blocked agent (hc --force; herdr: no-op). */
export type DeliverOptions = { readonly when?: DeliverWhen; readonly force?: boolean };
export type DeliverOutcome =
  | { readonly kind: "delivered"; readonly turn?: number; readonly started?: boolean }
  | { readonly kind: "no-agent" }
  | { readonly kind: "not-ready"; readonly status: AgentStatus }
  | { readonly kind: "typed"; readonly into: AgentIdentity; readonly failure: unknown }
  | { readonly kind: "ambiguous"; readonly detail: string; readonly failure: unknown };
export type SubmitResult = "submitted" | "wait" | "changed";
export type Key = "enter" | "escape";
export type CloseScope = "session" | "container";
/** `unwrapped`: a line the terminal wrapped over several rows comes back as one line, not one line per row. */
export type ReadOptions = { readonly unwrapped?: boolean };
export interface SessionRuntime {
  readonly kind: RuntimeKind;
  /** The caller's own session from the runtime's env (HERDR_PANE_ID + HERDR_WORKSPACE_ID / HC_TERMINAL_ID), or undefined. */
  self(): SessionRef | undefined;
  /** herdr: `workspace create --label <label> --cwd <cwd> --no-focus` -> the workspace id (its root pane is left as is, as today). hc: returns `label` unchanged, no call. */
  createGroup(label: string, cwd: string): Promise<string>;
  /** A session with the user's shell in it and nothing started. */
  create(spec: CreateSpec): Promise<SessionRef>;
  /** herdr: `pane run <id> <command>`. hc: `send <id> <command>` into the shell (no --if: a shell reports no status). */
  start(ref: SessionRef, command: string): Promise<void>;
  list(filter?: { readonly group?: string }): Promise<readonly SessionInfo[]>;
  probe(ref: SessionRef): Promise<Probe>;
  /** herdr: `pane read --source recent` (`recent-unwrapped` when unwrapped). hc: `read`; unwrapped joins rows as wide as the terminal's `cols`. */
  read(ref: SessionRef, lines: number, opts?: ReadOptions): Promise<string>;
  /** Never types into a session whose probe says shellInFront, whatever `status` says. Default `when` = "idle". */
  deliver(ref: SessionRef, text: string, opts?: DeliverOptions): Promise<DeliverOutcome>;
  submitTyped(ref: SessionRef, into: AgentIdentity): Promise<SubmitResult>;
  typeIntoShell(ref: SessionRef, text: string): Promise<boolean>;
  keys(ref: SessionRef, keys: readonly Key[]): Promise<void>;
  /** herdr: "session" = `pane close <id>`; "container" = `tab close <ref.container>` (pane close when the ref has no container). hc: kill then rm for both. Default "session". */
  close(ref: SessionRef, scope?: CloseScope): Promise<void>;
}

/** Id shape of a bare ref: only a herdr pane `w<ws>:p<pane>` may appear without its prefix. */
const BARE_HERDR = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;
/**
 * Id shape after each prefix: a herdr pane, or a local hc terminal address. hc numbers terminals in base 36 (`t7`,
 * `t1b`, `t2h`). Another machine's `<machine>/<address>` is not a ref: the id names the session's inbox file.
 */
const HC_ADDRESS = /^t[0-9a-z]+$/;
const ID_SHAPES: Readonly<Record<RuntimeKind, RegExp>> = { herdr: BARE_HERDR, hc: HC_ADDRESS };
const KINDS = Object.keys(ID_SHAPES) as RuntimeKind[];

/** "herdr:w1:p3", "hc:t7", bare "w1:p3" (herdr). A bare "t7" is NOT a ref (it is a legal lane key); undefined otherwise. */
export const parseRef: (text: string) => SessionRef | undefined = (text) => {
  for (const runtime of KINDS) {
    if (!text.startsWith(`${runtime}:`)) continue;
    const id = text.slice(runtime.length + 1);
    return ID_SHAPES[runtime].test(id) ? { runtime, id } : undefined;
  }
  return BARE_HERDR.test(text) ? { runtime: "herdr", id: text } : undefined;
};
export const formatRef: (ref: SessionRef) => string = (ref) => `${ref.runtime}:${ref.id}`;
/**
 * create + start in one call (the root harness path). A start that fails closes the session create just made (scope
 * "session"), so no idle shell is left behind, and rethrows the start error; a close that fails too is one stderr line.
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
    await rt.close(ref, "session").catch((closeError: unknown) => {
      const why = closeError instanceof Error ? closeError.message : String(closeError);
      process.stderr.write(`dori: could not close ${formatRef(ref)} after its start failed (${why})\n`);
    });
    throw e;
  }
  return ref;
};
