import type { RuntimeKind, SessionRef, SessionRuntime } from "./types.ts";

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

/**
 * The runtimes one process talks to: `default` is the selected kind (where new sessions open), `for(ref)` is the
 * runtime that owns a stored session. Each kind is built on first use and then reused.
 */
export class Runtimes {
  private readonly built = new Map<RuntimeKind, SessionRuntime>();

  /** `selected` may be lazy: a stored session's runtime (`for(ref)`) never needs the choice to be made. */
  constructor(
    private readonly selected: RuntimeKind | (() => RuntimeKind),
    private readonly make: (kind: RuntimeKind) => SessionRuntime,
  ) {}

  get default(): SessionRuntime {
    return this.of(typeof this.selected === "function" ? this.selected() : this.selected);
  }

  for(ref: SessionRef): SessionRuntime {
    return this.of(ref.runtime);
  }

  /** The kinds built so far, in first-use order, to enumerate sessions across every runtime in use. */
  kinds(): readonly RuntimeKind[] {
    return [...this.built.keys()];
  }

  /** The caller's own session: `HC_TERMINAL_ID` names the hc terminal it runs in. Builds no runtime. */
  selfAny(env: Readonly<Record<string, string | undefined>>): SessionRef | undefined {
    const terminal = nonEmpty(env["HC_TERMINAL_ID"]);
    return terminal === undefined ? undefined : { runtime: "hc", id: terminal };
  }

  private of(kind: RuntimeKind): SessionRuntime {
    let runtime = this.built.get(kind);
    if (runtime === undefined) {
      runtime = this.make(kind);
      this.built.set(kind, runtime);
    }
    return runtime;
  }
}
