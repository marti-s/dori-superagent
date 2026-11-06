import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { HerdrCore } from "../src/herdr-core.ts";
import type { AgentStatus, Exec, ExecOptions, ExecResult } from "../src/terminal.ts";
import { Store, type HostLoad } from "../src/store.ts";
import type { DutyCounts, TelemetryEvent, Usage } from "../src/telemetry.ts";
import { idleScreen } from "./fake-core.ts";

type Process = { name: string; argv: string[] };

/**
 * A terminal as hc shows it. `status` picks the screen and foreground process that HerdrCore derives that status from;
 * `screen` and `foreground` override them. `ran` holds launch commands, `received` every other text sent to it.
 */
type Pane = {
  status: AgentStatus; received: string[]; ran: string[];
  screen?: string | undefined; readFails?: boolean; foreground?: string | Process | null | undefined; tab?: string;
  /** The terminal's program has exited: hc still lists it, as `finished`, until `hc rm`. */
  finished?: boolean;
  /** hc's name and launch argv; a terminal dori runs gets `dori-...` and its env argv. */
  name?: string; argv?: string[];
  /** The app tab holding the terminal; defaults to a tab of its own. */
  appTab?: string;
};

const SCREENS: Partial<Record<AgentStatus, string>> = {
  idle: idleScreen,
  done: idleScreen,
  working: "• Working (3s • esc to interrupt)",
  blocked: "Question\nAllow this command? [y/n]",
  unknown: "loading...",
  shell: "$ ",
};

const ok = (value: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });

/** The hc and herdr-app wire contract over panes with a settable status, plus gh and the reviewer. */
export class World {
  panes = new Map<string, Pane>();
  calls: { cmd: string; argv: readonly string[] }[] = [];
  clock = 1_000_000;
  host: HostLoad = { load1: 1, cores: 8, memFreePct: 50 };
  next = 1;
  /** pane id -> hc error text returned by `send` of a message (exit 1); launch commands are unaffected */
  sendFails = new Map<string, string>();
  /** pane id -> called with the 1-based count of `get` calls for that pane before it answers; "fail" fails that get */
  getHook = new Map<string, (n: number) => void | "fail">();
  private gets = new Map<string, number>();
  /** number of upcoming `keys` calls that fail (exit 1) */
  keyFails = 0;
  gh: (argv: readonly string[]) => { code: number; stdout: string } = () => ({ code: 1, stdout: "" });
  usage: TelemetryEvent[] = [];
  dutyCounts: DutyCounts[] = [];
  touches = 0;
  recorder: Usage = {
    touch: () => { this.touches++; },
    record: (e) => { this.usage.push(e); },
    duty: (c) => { this.dutyCounts.push(c); },
    flush: async () => {},
  };
  /** App tabs closed with `tab.close`. */
  readonly closedTabs = new Set<string>();
  reviewer: (argv: readonly string[], opts?: ExecOptions) => { code: number; stdout: string; timedOut?: boolean } = () => ({ code: 0, stdout: "VERDICT: CLEAR" });

  addPane(id: string, status: AgentStatus = "idle"): Pane {
    const p: Pane = { status, received: [], ran: [] };
    this.panes.set(id, p);
    return p;
  }

  private foreground(pane: Pane): Process | null {
    const fg = pane.foreground === undefined ? (pane.status === "shell" ? "-bash" : "omo") : pane.foreground;
    return typeof fg === "string" ? { name: fg, argv: [fg] } : fg;
  }

  private app(argv: readonly string[]): ExecResult {
    if (argv[0] === "ls") {
      const byTab = new Map<string, { id: string; name: string; terminals: { terminal: string }[] }>();
      for (const [terminal, p] of this.panes) {
        const id = p.appTab ?? `tab-${terminal}`;
        if (this.closedTabs.has(id)) continue;
        const tab = byTab.get(id) ?? { id, name: p.tab ?? "", terminals: [] };
        tab.terminals.push({ terminal });
        byTab.set(id, tab);
      }
      return ok({ spaces: [{ id: "sp", name: "dori", tabs: [...byTab.values()] }] });
    }
    if (argv[0] === "do" && argv[1] === "tab.close") {
      // Like the real window, a tab whose last terminal hc removed is already gone.
      const id = String(argv[3]);
      const listed = [...this.panes].some(([terminal, p]) => (p.appTab ?? `tab-${terminal}`) === id);
      this.closedTabs.add(id);
      return listed ? ok({}) : fail(`no tab "${id}"`);
    }
    const pane = argv[0] === "do" && argv[1] === "tab.rename" ? this.panes.get(String(argv[3]).replace(/^tab-/, "")) : undefined;
    if (!pane) return fail(`unhandled herdr-app ${argv.join(" ")}`);
    pane.tab = String(argv[5]);
    return ok({});
  }

  exec: Exec = async (cmd, argv, opts) => {
    this.calls.push({ cmd, argv });
    if (cmd === "gh") return { ...this.gh(argv), stderr: "" };
    if (cmd === "herdr-app") return this.app(argv);
    if (cmd !== "hc") return { ...this.reviewer(argv, opts), stderr: "" };
    const [verb, id] = argv;
    if (verb === "ls") return ok({ terminals: [] });
    if (verb === "run") {
      const address = `t${++this.next}`;
      const pane = this.addPane(address, "shell");
      pane.name = argv[argv.indexOf("--name") + 1];
      pane.argv = argv.slice(argv.indexOf("--") + 1);
      return ok({ address, state: "live" });
    }
    const pane = id ? this.panes.get(id) : undefined;
    if (!pane) return { code: 3, stdout: JSON.stringify({ error: { kind: "not_found", message: `no terminal ${id}` } }), stderr: "" };
    switch (verb) {
      case "get": {
        const n = (this.gets.get(id!) ?? 0) + 1;
        this.gets.set(id!, n);
        if (this.getHook.get(id!)?.(n) === "fail") return fail("connection lost");
        return ok({
          address: id, name: pane.name ?? null, argv: pane.argv ?? [], state: pane.finished ? "finished" : "live",
          foreground: pane.finished ? null : this.foreground(pane), labels: {},
        });
      }
      case "read":
        return pane.readFails ? fail("read failed") : ok({ text: pane.screen ?? SCREENS[pane.status] ?? "" });
      case "send": {
        const text = String(argv[2]);
        const launch = /^exec \/bin\/sh -c '(.*)'$/s.exec(text);
        if (launch) {
          pane.ran.push(launch[1]!.replaceAll(`'\\''`, "'"));
          return ok({});
        }
        const failure = this.sendFails.get(id!);
        if (failure) return fail(failure);
        pane.received.push(text);
        return ok({});
      }
      case "keys":
        if (this.keyFails > 0) { this.keyFails--; return fail("key press failed"); }
        return ok({});
      case "kill":
        pane.finished = true;
        return ok({});
      case "rm":
        if (!pane.finished) return { code: 11, stdout: "", stderr: JSON.stringify({ error: { kind: "live", message: "kill it first" } }) };
        this.panes.delete(id!);
        return ok({});
    }
    return fail(`unhandled hc ${argv.join(" ")}`);
  };

  deps(): Deps {
    return {
      store: new Store(mkdtempSync(join(tmpdir(), "dori-test-"))),
      // No pause between tab-name lookups, and no caller environment: placement never depends on where tests run.
      herdr: new HerdrCore(this.exec, "hc", "herdr-app", async () => {}, {}),
      exec: this.exec,
      now: () => this.clock,
      agentCmd: "omo",
      reviewTimeoutMs: 25 * 60_000,
      tabCloseDelayMs: 15 * 60_000,
      doriCmd: "dori",
      host: () => this.host,
      usage: this.recorder,
    };
  }
}
