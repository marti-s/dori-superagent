import type { Exec } from "../exec.ts";
import { spawnExec } from "../exec.ts";
import type {
  AgentIdentity,
  CreateSpec,
  DeliverOptions,
  DeliverOutcome,
  Key,
  Probe,
  ReadOptions,
  SessionInfo,
  SessionRef,
  SessionRuntime,
  SubmitResult,
} from "../types.ts";
import { nameTab } from "./app.ts";
import { deliver, keys, read, typeIntoShell } from "./deliver.ts";
import { probe } from "./probe.ts";
import { close, create, list, selfRef, start, tabName } from "./sessions.ts";
import { inheritedEnv, placement } from "./space.ts";

export type HcRuntimeOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
};

/** herdr-core (`hc`) behind the session runtime interface, one `hc --json` call per step; tabs through `herdr-app`. */
export class HcRuntime implements SessionRuntime {
  readonly kind = "hc";
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  /** The `herdr-app` binary: `DORI_HERDR_APP`, else the one on PATH. */
  private readonly app: string;

  constructor(
    private readonly exec: Exec = spawnExec,
    options: HcRuntimeOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.log = options.log ?? ((line) => void process.stderr.write(`${line}\n`));
    this.app = this.env["DORI_HERDR_APP"] || "herdr-app";
  }

  self(): SessionRef | undefined {
    return selfRef(this.env);
  }

  /**
   * The terminal carries the caller's own `DORI_*` settings and PATH under the spec's env, and joins the Herdr app
   * space of `DORI_HERDR_SPACE` or of the terminal Dori runs in. A terminal placed in a space has its tab named.
   */
  async create(spec: CreateSpec): Promise<SessionRef> {
    const space = await placement(this.exec, this.env);
    const env = { ...inheritedEnv(this.env), ...spec.env };
    const ref = await create(this.exec, { ...spec, env }, this.env["SHELL"] || "sh", space);
    if (space !== undefined) await nameTab(this.exec, this.app, ref.id, tabName(spec), this.sleep, this.log);
    return ref;
  }

  start(ref: SessionRef, command: string): Promise<void> {
    return start(this.exec, ref.id, command);
  }

  list(filter?: { readonly group?: string }): Promise<readonly SessionInfo[]> {
    return list(this.exec, filter?.group);
  }

  probe(ref: SessionRef): Promise<Probe> {
    return probe(this.exec, ref.id);
  }

  read(ref: SessionRef, lines: number, opts?: ReadOptions): Promise<string> {
    return read(this.exec, ref.id, lines, opts?.unwrapped ?? false);
  }

  deliver(ref: SessionRef, text: string, opts?: DeliverOptions): Promise<DeliverOutcome> {
    return deliver(this.exec, ref.id, text, opts);
  }

  /**
   * Always `changed`, touching nothing: hc's send pastes and presses Enter in one step, so it never leaves typed text
   * waiting for an Enter. A `typed` entry can only come from a record another binary wrote, and pressing Enter here
   * would submit whatever a person has in this input instead (#108).
   */
  async submitTyped(_ref: SessionRef, _into: AgentIdentity): Promise<SubmitResult> {
    return "changed";
  }

  typeIntoShell(ref: SessionRef, text: string): Promise<boolean> {
    return typeIntoShell(this.exec, ref.id, text);
  }

  keys(ref: SessionRef, names: readonly Key[]): Promise<void> {
    return keys(this.exec, ref.id, names);
  }

  close(ref: SessionRef): Promise<void> {
    return close(this.exec, ref.id, this.sleep, this.log);
  }
}
