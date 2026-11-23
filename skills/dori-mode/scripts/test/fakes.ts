import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoriConfig, defaultConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { Registry } from "../src/registry.ts";
import type { Clock, Ran, Runner } from "../src/run.ts";
import { type HcTerm, hcAnswer, hcTerm } from "./hc-runner.ts";

export type World = {
  prState: string;
  issueState: string;
  aheadCount: string | Record<string, string>;
  dirty: string | Record<string, string>;
  /** `git worktree list --porcelain` output; defaults to a cwd plus one lane-owned worktree. */
  worktreeList?: string;
  /** `git rev-parse --is-inside-work-tree` answer; a lane whose cwd is not a checkout gets "false". */
  isGitRepo?: string;
  stuckReads: number;
  screen: string;
  /**
   * Terminals in short form: `pane_id` is the hc address, `workspace_id` its `dori.group` label, `agent_status` the
   * word the agent reports (absent: it never reported). `foreground` is the process hc reports in front; it defaults
   * to the agent, or `-bash` for a pane with no agent. `finished`: the terminal's program has ended.
   */
  panes: Pane[];
  /** agent_status the target pane moves to when a message is sent to it (models a lane picking up the message). */
  onEnterStatus?: string;
  /** Screens returned by successive reads of a pane; falls back to `screen` when empty. */
  screens?: string[];
  /** hc terminals by address in full form, beside `panes`. */
  terminals: Record<string, HcTerm>;
  calls: string[][];
};

export type Pane = {
  pane_id: string;
  workspace_id: string;
  agent?: string;
  agent_status?: string;
  title?: string;
  cwd?: string;
  /** null: hc cannot say what is in front. */
  foreground?: string | { name: string; argv: string[] } | null;
  finished?: boolean;
};

export const WT = "/repo/.wt/demo-lane";

const REPORTED: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done", "error"]);

/** A `panes` entry as the hc terminal it stands for. */
const termOf = (p: Pane): HcTerm => {
  const fg = p.foreground === null ? null : (p.foreground ?? p.agent ?? (p.agent_status ? "agent" : "-bash"));
  return hcTerm({
    state: p.finished ? "finished" : "live",
    status: p.agent_status && REPORTED.has(p.agent_status) ? { state: p.agent_status, app: p.agent ?? "omo" } : null,
    foreground: fg === null ? null : { ...(typeof fg === "string" ? { name: fg, argv: [fg] } : fg), pid: 101 },
    labels: { "dori.group": p.workspace_id },
    ...(p.title ? { title: p.title } : {}),
    ...(p.cwd ? { cwd: p.cwd } : {}),
  });
};

/** One `hc` call over the panes and the terminals together; what hc changed is written back to the pane. */
const hc = (w: World, argv: readonly string[]): Ran => {
  const view = { ...Object.fromEntries(w.panes.map((p) => [p.pane_id, termOf(p)])), ...w.terminals };
  const address = argv[3] ?? "";
  // The world's one screen is what any address shows, a lane's whose terminal is not listed included; a terminal in
  // full form shows its own.
  if (argv[2] === "read" && w.terminals[address]?.screen === undefined) {
    // A 30-line read is the runtime's own idle check on a working agent (probe.ts): it sees the current screen and
    // leaves the scripted ones for the reads of the code under test.
    if (argv.at(-1) === "30") return { code: 0, out: JSON.stringify({ text: w.screens?.[0] ?? w.screen }), err: "" };
    let text = w.screens?.length ? (w.screens.shift() ?? w.screen) : w.screen;
    if (w.stuckReads > 0) {
      w.stuckReads--;
      text = "❯ [LEAD] stuck text still here";
    }
    return { code: 0, out: JSON.stringify({ text }), err: "" };
  }
  const answer = hcAnswer({ terminals: view, ...(w.onEnterStatus ? { onEnterStatus: w.onEnterStatus } : {}) }, argv);
  for (const [address, t] of Object.entries(view)) {
    const p = w.panes.find((x) => x.pane_id === address);
    if (!p) w.terminals[address] = t;
    else if (t.status) p.agent_status = t.status.state;
    if (p && t.state === "finished") p.finished = true;
  }
  w.panes = w.panes.filter((p) => p.pane_id in view);
  for (const address of Object.keys(w.terminals)) if (!(address in view)) delete w.terminals[address];
  return answer;
};

export const newWorld = (): World => ({
  prState: "MERGED",
  issueState: "CLOSED",
  aheadCount: "0",
  dirty: "",
  stuckReads: 0,
  screen: "❯ ",
  panes: [],
  terminals: {},
  calls: [],
});

export const fakeRunner =
  (w: World): Runner =>
  async (argv) => {
    w.calls.push([...argv]);
    const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
    const [cmd, a1] = argv;
    if (cmd === "hc") return hc(w, argv);
    if (cmd === "git" && argv.includes("worktree") && argv.includes("list"))
      return ok(
        w.worktreeList ?? `worktree /repo\nbranch refs/heads/main\n\nworktree ${WT}\nbranch refs/heads/demo-lane`,
      );
    if (cmd === "git" && argv.includes("rev-parse") && argv.includes("--is-inside-work-tree"))
      return ok(w.isGitRepo ?? "true");
    // Outside a readable checkout, git status and rev-list fail as real git does (exit 128).
    if (cmd === "git" && w.isGitRepo === "false" && (argv.includes("status") || argv.includes("rev-list")))
      return { code: 128, out: "", err: "fatal: not a git repository" };
    if (cmd === "git" && argv.includes("status"))
      return ok(typeof w.dirty === "string" ? w.dirty : (w.dirty[argv[2] ?? ""] ?? ""));
    if (cmd === "git" && argv.includes("rev-list"))
      return ok(typeof w.aheadCount === "string" ? w.aheadCount : (w.aheadCount[argv[2] ?? ""] ?? "0"));
    if (cmd === "git") return ok();
    if (cmd === "gh" && a1 === "pr")
      return ok(
        JSON.stringify({ state: w.prState, mergeCommit: w.prState === "MERGED" ? { oid: "abc1234567890" } : null }),
      );
    if (cmd === "gh" && a1 === "issue") return ok(JSON.stringify({ state: w.issueState }));
    if (cmd === "notify") return ok();
    return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` };
  };

/** What `hc run` answers for a new terminal at `address`, after adding it to the world with a shell in front. */
export const hcCreated = (w: World, address: string): Ran => {
  w.terminals[address] = hcTerm({ status: null, foreground: { name: "zsh", argv: ["zsh"], pid: 950 }, turn: 0 });
  return { code: 0, out: JSON.stringify({ address, state: "live" }), err: "" };
};

/** What `hc ls` answers for one live terminal with the given status word (none: it has not reported). */
export const hcListed = (address: string, status?: string): Ran => ({
  code: 0,
  out: JSON.stringify({ terminals: [{ address, state: "live", ...(status ? { status } : {}) }] }),
  err: "",
});

export const fakeClock = (start: number): Clock & { at: number } => {
  const c = { at: start, now: () => c.at, sleep: async () => {} };
  return c;
};

export const withState = (): { dir: string; done: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "dori-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};

export const depsFor = (w: World, clock: Clock, stateDir: string, patch: Partial<DoriConfig> = {}): FlowDeps => {
  const config: DoriConfig = {
    ...defaultConfig("/home/test"),
    stateDir,
    defaultCwd: "/repo",
    leadPane: "lead:p1",
    runtime: "hc",
    ...patch,
  };
  return { run: fakeRunner(w), clock, registry: new Registry(stateDir), config, exists: () => true, env: {} };
};

/** Texts delivered with `hc send` (the last argv element), in order. */
export const sent = (w: World): string[] =>
  w.calls.filter((c) => c[0] === "hc" && c[2] === "send").map((c) => c.at(-1) ?? "");
