import { type Exec, spawnExec } from "../exec.ts";
import type {
  AgentIdentity,
  CloseScope,
  CreateSpec,
  DeliverOptions,
  DeliverOutcome,
  Key,
  Probe,
  SessionInfo,
  ReadOptions,
  SessionRef,
  SessionRuntime,
  SubmitResult,
} from "../types.ts";
import { deliver, keys, type Sleep, submitTyped, typeIntoShell } from "./deliver.ts";
import { HerdrCli } from "./exec.ts";
import { probe } from "./probe.ts";
import { close, create, createGroup, type Env, list, self, start } from "./sessions.ts";

export type { Sleep } from "./deliver.ts";
export { HerdrError } from "./exec.ts";
export { omoScreenIdle } from "./probe.ts";

export type HerdrOptions = { readonly env?: Env; readonly sleep?: Sleep };

/** herdr behind the session runtime interface: a session is a pane, its group the pane's workspace. */
export class HerdrRuntime implements SessionRuntime {
  readonly kind = "herdr" as const;
  private readonly cli: HerdrCli;
  private readonly env: Env;
  private readonly sleep: Sleep;

  constructor(
    exec: Exec = spawnExec,
    session: string | undefined = process.env["DORI_HERDR_SESSION"],
    options: HerdrOptions = {},
  ) {
    this.cli = new HerdrCli(exec, session);
    this.env = options.env ?? process.env;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  }

  self(): SessionRef | undefined {
    return self(this.env);
  }

  createGroup(label: string, cwd: string): Promise<string> {
    return createGroup(this.cli, label, cwd);
  }

  create(spec: CreateSpec): Promise<SessionRef> {
    return create(this.cli, spec);
  }

  start(ref: SessionRef, command: string): Promise<void> {
    return start(this.cli, ref.id, command);
  }

  list(filter?: { readonly group?: string }): Promise<readonly SessionInfo[]> {
    return list(this.cli, filter?.group);
  }

  probe(ref: SessionRef): Promise<Probe> {
    return probe(this.cli, ref.id);
  }

  read(ref: SessionRef, lines: number, opts?: ReadOptions): Promise<string> {
    return this.cli.read(ref.id, lines, opts?.unwrapped ? "recent-unwrapped" : "recent");
  }

  /** herdr types whatever the status word says (the caller decided), so `when` and `force` change nothing here. */
  deliver(ref: SessionRef, text: string, _opts?: DeliverOptions): Promise<DeliverOutcome> {
    return deliver(this.cli, ref.id, text, this.sleep);
  }

  submitTyped(ref: SessionRef, into: AgentIdentity): Promise<SubmitResult> {
    return submitTyped(this.cli, ref.id, into);
  }

  typeIntoShell(ref: SessionRef, text: string): Promise<boolean> {
    return typeIntoShell(this.cli, ref.id, text);
  }

  keys(ref: SessionRef, pressed: readonly Key[]): Promise<void> {
    return keys(this.cli, ref.id, pressed);
  }

  close(ref: SessionRef, scope: CloseScope = "session"): Promise<void> {
    return close(this.cli, ref, scope);
  }
}
