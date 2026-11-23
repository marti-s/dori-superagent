import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { HcRuntime } from "../src/runtime/hc/index.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import type { AgentStatus, SessionRef } from "../src/runtime/types.ts";
import { Store, type HostLoad } from "../src/store.ts";
import type { DutyCounts, TelemetryEvent, Usage } from "../src/telemetry.ts";
import { FakeHc, type FakeTerminal, terminal } from "./fake-hc.ts";

/** An hc terminal ref, the form every test addresses sessions by. */
export const sref = (id: string): SessionRef => ({ runtime: "hc", id });

type Foreground = string | { name: string; argv: string[] } | null;
const SHELL: Foreground = "-zsh";
const REPORTED: readonly AgentStatus[] = ["idle", "working", "blocked", "error", "done"];

/**
 * One hc terminal as a test steers it. `status` is the word the agent reports; `shell` is a terminal with no agent (a
 * shell in front) and `unknown` a program that never reported. `received` holds what was delivered to the agent,
 * `ran` what was typed into the shell (the start command, `--to-shell`).
 */
export class Pane {
  received: string[] = [];
  ran: string[] = [];

  constructor(readonly terminal: FakeTerminal) {}

  get status(): AgentStatus {
    const word = this.terminal.status?.state;
    if (word !== undefined) return REPORTED.find((s) => s === word) ?? "unknown";
    return this.shellInFront() ? "shell" : "unknown";
  }

  set status(status: AgentStatus) {
    const reports = REPORTED.includes(status);
    this.terminal.status = reports ? { state: status, app: "omo" } : null;
    this.terminal.reported = reports;
    this.foreground = status === "shell" ? SHELL : "omo";
  }

  /** What `hc read` returns for the terminal. */
  get screen(): string | undefined {
    return this.terminal.screen;
  }

  set screen(text: string | undefined) {
    if (text === undefined) delete this.terminal.screen;
    else this.terminal.screen = text;
  }

  /** The foreground process `hc get` reports: a name, a full process, or null when hc cannot say. */
  set foreground(fg: Foreground) {
    this.terminal.foreground =
      fg === null ? null : typeof fg === "string" ? { name: fg, argv: [fg], pid: 4242 } : { ...fg, pid: 4242 };
  }

  /** The terminal's program has ended: hc still lists it, as `finished`. */
  set finished(done: boolean) {
    this.terminal.state = done ? "finished" : "live";
  }

  shellInFront(): boolean {
    const name = this.terminal.foreground?.name.replace(/^-/, "");
    return name === undefined || ["sh", "bash", "zsh", "fish"].includes(name);
  }
}

/** The world's terminals by address; deleting one removes it from hc too (a terminal that is gone). */
class Panes extends Map<string, Pane> {
  constructor(private readonly hc: FakeHc) {
    super();
  }

  override delete(id: string): boolean {
    this.hc.terminals.delete(id);
    return super.delete(id);
  }
}

export class World {
  /** The recorder standing in for the `hc` binary; its calls are recorded in `calls` too. */
  hc = new FakeHc();
  panes = new Panes(this.hc);
  calls: { cmd: string; argv: readonly string[] }[] = [];
  clock = 1_000_000;
  host: HostLoad = { load1: 1, cores: 8, memFreePct: 50 };
  /** terminal address -> called with the 1-based count of `hc get` calls for it, before it answers */
  getHook = new Map<string, (n: number) => void>();
  private gets = new Map<string, number>();
  /** terminal address -> every `hc send` to it exits 1 with this text and no JSON: the text may or may not have arrived */
  sendFails = new Map<string, string>();
  /** terminal address -> called right before an `hc send` reaches it: what changed since the probe */
  beforeSend = new Map<string, () => void>();
  /** a command named `slow-hook` awaits this before answering (a hook that hangs) */
  hang: Promise<void> | undefined;
  /** called when a hanging `slow-hook` is killed; the killed hook then exits 143 */
  onHookKill: (() => void) | undefined;
  gh: (argv: readonly string[]) => { code: number; stdout: string } = () => ({ code: 1, stdout: "" });
  usage: TelemetryEvent[] = [];
  dutyCounts: DutyCounts[] = [];
  touches = 0;
  recorder: Usage = {
    touch: () => {
      this.touches++;
    },
    record: (e) => {
      this.usage.push(e);
    },
    duty: (c) => {
      this.dutyCounts.push(c);
    },
    flush: async () => {},
  };
  /** every command other than hc and gh: the reviewer, and lifecycle hooks */
  reviewer: (argv: readonly string[]) => { code: number; stdout: string; stderr?: string } = () => ({
    code: 0,
    stdout: "VERDICT: CLEAR",
  });

  addPane(id: string, status: AgentStatus = "idle"): Pane {
    const t = terminal();
    this.hc.terminals.set(id, t);
    const pane = new Pane(t);
    pane.status = status;
    this.panes.set(id, pane);
    return pane;
  }

  /** The hc verb and terminal address of a recorded call (`hc --json <verb> <id> ...`). */
  hcCalls(verb: string, id?: string): (readonly string[])[] {
    return this.calls
      .filter((c) => c.cmd === "hc" && c.argv[1] === verb && (id === undefined || c.argv[2] === id))
      .map((c) => c.argv);
  }

  exec: Exec = async (cmd, argv, options) => {
    this.calls.push({ cmd, argv });
    if (cmd === "slow-hook" && this.hang) {
      let killed = false;
      const kill = new Promise<void>((resolve) =>
        options?.onSpawn?.({
          kill: () => {
            killed = true;
            this.onHookKill?.();
            resolve();
          },
        }),
      );
      await Promise.race([this.hang, kill]);
      if (killed) return { code: 143, stdout: "", stderr: "terminated" };
    }
    if (cmd === "gh") return { ...this.gh(argv), stderr: "" };
    if (cmd === "herdr-app") return this.hc.exec(cmd, argv);
    if (cmd !== "hc") return { stderr: "", ...this.reviewer(argv) };
    return this.hcExec(argv);
  };

  private async hcExec(argv: readonly string[]): Promise<Awaited<ReturnType<Exec>>> {
    const [, verb, id] = argv;
    if (verb === "get" && id !== undefined) {
      const n = (this.gets.get(id) ?? 0) + 1;
      this.gets.set(id, n);
      this.getHook.get(id)?.(n);
    }
    const before = new Set(this.hc.terminals.keys());
    const pane = id === undefined ? undefined : this.panes.get(id);
    if (verb === "send" && id !== undefined) this.beforeSend.get(id)?.();
    const intoShell = pane?.status === "shell";
    const broken = verb === "send" && id !== undefined ? this.sendFails.get(id) : undefined;
    if (broken !== undefined) return { code: 1, stdout: "", stderr: `${broken}\n` };
    const result = await this.hc.exec("hc", argv);
    if (verb === "run") {
      // A terminal hc just started runs the user's shell and nothing else.
      for (const [address, t] of this.hc.terminals) {
        if (before.has(address)) continue;
        const created = new Pane(t);
        created.status = "shell";
        this.panes.set(address, created);
      }
    }
    if (verb === "send" && result.code === 0 && pane !== undefined)
      (intoShell ? pane.ran : pane.received).push(String(argv.at(-1)));
    if (verb === "rm" && result.code === 0 && id !== undefined) this.panes.delete(id);
    return result;
  }

  /** Deps over this world's recorders. */
  deps(): Deps {
    const quiet = { env: {}, sleep: async () => {}, log: () => {} };
    return {
      store: new Store(mkdtempSync(join(tmpdir(), "dori-test-"))),
      runtimes: new Runtimes("hc", () => new HcRuntime(this.exec, quiet)),
      choice: () => ({ kind: "hc", source: "config" }),
      exec: this.exec,
      now: () => this.clock,
      agentCmd: "omo",
      doriCmd: "dori",
      host: () => this.host,
      usage: this.recorder,
    };
  }
}
