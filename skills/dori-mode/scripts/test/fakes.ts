import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoriConfig, defaultConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { Registry } from "../src/registry.ts";
import type { Clock, Ran, Runner } from "../src/run.ts";

export type FakeProc = { name: string; argv: string[] };

/** One hc terminal. `pane_id` is its address; `workspace_id` is the space segment of its `where`. */
export type FakePane = {
  pane_id: string;
  workspace_id: string;
  agent?: string;
  /**
   * The agent state the screen shows: "idle", "working" or "blocked" are rendered as a footer appended to every read of
   * this pane (see STATUS_FOOTER); "done" makes hc report the terminal finished; anything else renders nothing.
   */
  agent_status?: string;
  title?: string;
  cwd?: string;
  /** What `hc get` reports in the foreground; defaults to the agent, or `-bash` for a pane with no agent and no status. A list keeps only its first entry. */
  foreground?: string | FakeProc[] | null;
  /** `hc get` root pid; defaults to 100. */
  pid?: number;
};

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
  panes: FakePane[];
  /** agent_status the target pane moves to after an `hc send` (models a lane picking up the message). */
  onEnterStatus?: string;
  /** Screens returned by successive `hc read` calls (any pane, status reads included); falls back to `screen` when empty. */
  screens?: string[];
  /** Address the next `hc run` returns; defaults to "t${panes.length + 1}w". The launched terminal joins `panes`. */
  launchAddress?: string;
  /** Every hc command fails with exit 1, as when the hc server is down. */
  hcDown?: boolean;
  /** Every herdr-app command fails with exit 1, as when the window is not running. */
  appDown?: boolean;
  calls: string[][];
};

export const WT = "/repo/.wt/demo-lane";
const RULE = "─".repeat(20);
/** The screen footer each modelled status renders; panes.ts screenStatus classifies each as its key. */
export const STATUS_FOOTER: Readonly<Record<string, string>> = {
  idle: `${RULE}\n❯\n${RULE}`,
  working: "⠋ Working (esc to interrupt)",
  blocked: "Allow this command? [y/n]",
};

export const newWorld = (): World => ({ prState: "MERGED", issueState: "CLOSED", aheadCount: "0", dirty: "", stuckReads: 0, screen: "❯ ", panes: [], calls: [] });

const whereOf = (p: FakePane): string => `${p.workspace_id} / ${p.title ?? p.pane_id}`;
const foregroundOf = (p: FakePane): (FakeProc & { pid: number; cwd: string }) | null => {
  if (p.agent_status === "done") return null;
  const fg = p.foreground === undefined ? (p.agent ?? (p.agent_status ? "agent" : "-bash")) : p.foreground;
  const proc = fg === null ? undefined : typeof fg === "string" ? { name: fg, argv: [fg] } : fg[0];
  return proc ? { ...proc, pid: (p.pid ?? 100) + 1, cwd: p.cwd ?? "/repo" } : null;
};
const flag = (argv: readonly string[], name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));

export const fakeRunner = (w: World): Runner => async (argv) => {
  w.calls.push([...argv]);
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
  const [cmd, a1, a2] = argv;
  if (cmd === "hc" && w.hcDown) return { code: 1, out: "", err: "hc: server not running" };
  if (cmd === "herdr-app" && w.appDown) return { code: 1, out: JSON.stringify({ error: "app not running" }), err: "" };
  const pane = (id: string | undefined) => w.panes.find((x) => x.pane_id === id);
  if (cmd === "hc" && a1 === "read") {
    if (w.stuckReads > 0) {
      w.stuckReads--;
      return ok("❯ [LEAD] stuck text still here");
    }
    const base = w.screens?.length ? (w.screens.shift() ?? w.screen) : w.screen;
    const footer = STATUS_FOOTER[pane(a2)?.agent_status ?? ""];
    return ok(footer ? `${base}\n${footer}` : base);
  }
  if (cmd === "hc" && a1 === "send") {
    const p = pane(a2);
    if (!p) return { code: 3, out: JSON.stringify({ error: { kind: "not_found" } }), err: "" };
    if (w.onEnterStatus) p.agent_status = w.onEnterStatus;
    return ok();
  }
  if (cmd === "hc" && a1 === "ls") {
    return ok(JSON.stringify({ terminals: w.panes.map((p) => ({ address: p.pane_id, name: p.title ?? p.pane_id, cwd: p.cwd ?? "/repo", where: whereOf(p), agent: p.agent ?? null, state: p.agent_status === "done" ? "finished" : "live", turn: null })) }));
  }
  if (cmd === "hc" && a1 === "get") {
    const p = pane(a2);
    if (!p) return { code: 3, out: JSON.stringify({ error: { kind: "not_found" } }), err: "" };
    return ok(JSON.stringify({ address: p.pane_id, state: p.agent_status === "done" ? "finished" : "live", pid: p.pid ?? 100, foreground: foregroundOf(p), labels: { "herdr.space": p.workspace_id, where: whereOf(p) } }));
  }
  if (cmd === "hc" && (a1 === "keys" || a1 === "kill")) return pane(a2) ? ok() : { code: 3, out: JSON.stringify({ error: { kind: "not_found" } }), err: "" };
  if (cmd === "hc" && a1 === "rm") {
    const at = w.panes.findIndex((x) => x.pane_id === a2);
    if (at < 0) return { code: 3, out: JSON.stringify({ error: { kind: "not_found" } }), err: "" };
    w.panes.splice(at, 1);
    return ok();
  }
  if (cmd === "hc" && a1 === "run") {
    const address = w.launchAddress ?? `t${w.panes.length + 1}w`;
    const sep = argv.indexOf("--");
    const where = flag(argv, "--label").find((l) => l.startsWith("where="))?.slice("where=".length) ?? "";
    w.panes.push({ pane_id: address, workspace_id: where.split(" / ")[0] ?? "", title: flag(argv, "--name")[0] ?? address, cwd: flag(argv, "--cwd")[0] ?? "/repo", ...(sep >= 0 && argv[sep + 1] ? { agent: argv[sep + 1] } : {}) });
    return ok(JSON.stringify({ address }));
  }
  if (cmd === "hc") return ok();
  if (cmd === "herdr-app" && a1 === "ls") {
    const spaces = [...new Set(w.panes.map((p) => p.workspace_id))].map((space) => ({
      id: space, name: space,
      tabs: w.panes.filter((p) => p.workspace_id === space).map((p) => ({ id: `tab-${p.pane_id}`, name: p.title ?? p.pane_id, terminals: [{ id: `pane-${p.pane_id}`, terminal: p.pane_id }] })),
    }));
    return ok(JSON.stringify({ spaces }));
  }
  if (cmd === "herdr-app" && a1 === "do" && a2 === "tab.rename") {
    const p = pane(flag(argv, "--id")[0]?.replace(/^tab-/, ""));
    if (!p) return { code: 1, out: JSON.stringify({ error: "no such tab" }), err: "" };
    p.title = flag(argv, "--name")[0] ?? p.title;
    return ok("{}");
  }
  if (cmd === "git" && argv.includes("worktree") && argv.includes("list")) return ok(w.worktreeList ?? `worktree /repo\nbranch refs/heads/main\n\nworktree ${WT}\nbranch refs/heads/demo-lane`);
  if (cmd === "git" && argv.includes("rev-parse") && argv.includes("--is-inside-work-tree")) return ok(w.isGitRepo ?? "true");
  // Outside a readable checkout, git status and rev-list fail as real git does (exit 128).
  if (cmd === "git" && w.isGitRepo === "false" && (argv.includes("status") || argv.includes("rev-list"))) return { code: 128, out: "", err: "fatal: not a git repository" };
  if (cmd === "git" && argv.includes("status")) return ok(typeof w.dirty === "string" ? w.dirty : (w.dirty[argv[2] ?? ""] ?? ""));
  if (cmd === "git" && argv.includes("rev-list")) return ok(typeof w.aheadCount === "string" ? w.aheadCount : (w.aheadCount[argv[2] ?? ""] ?? "0"));
  if (cmd === "git") return ok();
  if (cmd === "gh" && a1 === "pr") return ok(JSON.stringify({ state: w.prState, mergeCommit: w.prState === "MERGED" ? { oid: "abc1234567890" } : null }));
  if (cmd === "gh" && a1 === "issue") return ok(JSON.stringify({ state: w.issueState }));
  if (cmd === "notify") return ok();
  return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` };
};

export const fakeClock = (start: number): Clock & { at: number } => {
  const c = { at: start, now: () => c.at, sleep: async () => {} };
  return c;
};

export const withState = (): { dir: string; done: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "dori-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};

export const depsFor = (w: World, clock: Clock, stateDir: string, patch: Partial<DoriConfig> = {}): FlowDeps => {
  const config: DoriConfig = { ...defaultConfig("/home/test"), stateDir, defaultCwd: "/repo", leadPane: "lead:p1", ...patch };
  return { run: fakeRunner(w), clock, registry: new Registry(stateDir), config, exists: () => true };
};

/** The texts of every `hc send` call, in order. */
export const sent = (w: World): string[] => w.calls.filter((c) => c[0] === "hc" && c[1] === "send").map((c) => c[3] ?? "");
