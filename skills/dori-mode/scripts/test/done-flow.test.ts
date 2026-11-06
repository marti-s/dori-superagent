import { afterEach, beforeEach, expect, test } from "bun:test";

import { claimDone, closeLane, objectDone, watchTick } from "../src/done-flow.ts";
import { sendVerified, UnsafeTextError } from "../src/panes.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World, WT } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const lane: Lane = { key: "demo-lane", title: "demo", thread: "chat:team/123", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1; closed acme/app#2", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
const closedVia = () => world.calls.filter((c) => c[0] === "hc" && c[1] === "kill");
const sends = () => world.calls.filter((c) => c[0] === "hc" && c[1] === "send");

beforeEach(async () => {
  state = withState();
  world = newWorld();
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

test("an objection inside the window keeps the lane open and the lane hears why", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  await objectDone(at(T0 + MIN), (await at(T0).registry.read("demo-lane")) ?? lane, ["changelog entry missing"]);
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(closedVia()).toHaveLength(0);
  expect(sent(world).some((t) => t.startsWith("[LEAD] not done: changelog entry missing"))).toBe(true);
});

test("five quiet minutes after a claim the lane is closed, its thread marked done and its worktree removed", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  expect(await watchTick(at(T0 + 4 * MIN))).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123"]);
  expect(closedVia()).toHaveLength(0);
  const lines = await watchTick(at(T0 + 5 * MIN + 1));
  expect(lines[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toEqual([["hc", "kill", "w:p1"]]);
  expect(world.calls).toContainEqual(["hc", "rm", "w:p1"]);
  expect(world.calls).toContainEqual(["notify", "chat:team/123", "Done: merged acme/app#1 abc123"]);
  expect(world.calls).toContainEqual(["git", "-C", "/repo", "worktree", "remove", WT]);
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("closed");
  expect(await watchTick(at(T0 + 9 * MIN))).toEqual([]);
});

test("commits that reached no remote block the close and name the worktree", async () => {
  world.aheadCount = "2";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("uncommitted tracked changes also block the close", async () => {
  world.dirty = " M src/app.ts";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

// A lane that never created a worktree works straight in its cwd. discoverWorktrees only returns
// worktrees named after the lane key, so that lane used to be checked nowhere and closed on dirty work.
test("a lane with no worktree of its own is still checked in its cwd", async () => {
  world.worktreeList = "worktree /repo\nbranch refs/heads/main";
  world.dirty = " M src/app.ts";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual(["unpushed work in /repo"]);
  expect(closedVia()).toHaveLength(0);
});

test("a lane whose worktree is clean is not blocked by the human's checkout", async () => {
  world.dirty = { [WT]: "", "/repo": " M notes/todo.md" };
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  await watchTick(at(T0 + 4 * MIN));
  const lines = await watchTick(at(T0 + 6 * MIN));
  expect(lines[0]).toStartWith("LANE_CLOSED demo-lane");
});

test("a cwd that is not a git checkout raises no objection of its own", async () => {
  world.worktreeList = "";
  world.isGitRepo = "false";
  world.dirty = "";
  world.aheadCount = "0";
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  await watchTick(at(T0 + 4 * MIN));
  const lines = await watchTick(at(T0 + 6 * MIN));
  expect(lines[0]).toStartWith("LANE_CLOSED demo-lane");
});

// The not-a-checkout skip is for the cwd fallback only: a worktree the lane owns whose git state cannot be read must
// still block the close, as it did before #39 (#42).
test("a lane-owned worktree whose git state is unreadable still blocks the close", async () => {
  world.isGitRepo = "false";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([`unpushed work in ${WT} (git state unreadable)`]);
  expect(closedVia()).toHaveLength(0);
});

test("an unpushed commit in the cwd of a lane with no worktree blocks the close", async () => {
  world.worktreeList = "worktree /repo\nbranch refs/heads/main";
  world.dirty = "";
  world.aheadCount = { "/repo": "2" };
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual(["unpushed work in /repo"]);
  expect(closedVia()).toHaveLength(0);
});

test("a Done signal that does not read back live becomes the objection", async () => {
  world.issueState = "OPEN";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(after?.objection?.reasons).toEqual(["closed acme/app#2 -> OPEN"]);
  expect(closedVia()).toHaveLength(0);
});

test("a watcher restarted inside the window keeps the original deadline and announces the claim once", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1");
  const first = await watchTick(at(T0 + 2 * MIN));
  const afterRestart = await watchTick(at(T0 + 3 * MIN));
  const settled = await watchTick(at(T0 + 6 * MIN));
  expect(first).toHaveLength(1);
  expect(afterRestart).toEqual([]);
  expect(settled[0]).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toHaveLength(1);
});

test("closing directly refuses while a signal is not live and leaves the pane alone", async () => {
  world.prState = "OPEN";
  const r = await closeLane(at(T0), lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toStartWith("REFUSED demo-lane");
  expect(closedVia()).toHaveLength(0);
});

test("delivery is confirmed by the pane's agent status moving to working, with exactly one Enter", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.onEnterStatus = "working";
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] please report")).toBe("delivered");
  expect(sends()).toHaveLength(1);
});

test("a screen that still shows the text never causes another Enter; no status change is unconfirmed", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.screens = ["❯ ", ...Array(6).fill("❯ [LEAD] stuck text still here")];
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] stuck text still here")).toBe("unconfirmed");
  expect(sends()).toHaveLength(1);
});

test("a pane that was already working cannot show a change, so the send is unconfirmed, not delivered", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "working" }];
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] queued while busy")).toBe("unconfirmed");
  expect(sends()).toHaveLength(1);
});

test("a pane with no running agent is a bare shell: nothing is typed, the send fails", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] please report")).toBe("failed");
  world.panes = [];
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] please report")).toBe("failed");
  expect(sends()).toHaveLength(0);
});

test("an agent suspended with Ctrl+Z is still reported idle, but the shell is in front: nothing is typed", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "opencode", agent_status: "idle", foreground: "-zsh" }];
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] please report")).toBe("failed");
  expect(sends()).toHaveLength(0);
});

test("an agent with a non-interactive sh -c child in front is delivered to; an empty foreground group is doubt", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle", foreground: [{ name: "pi", argv: ["pi"] }, { name: "sh", argv: ["sh", "-c", "true"] }] }];
  world.onEnterStatus = "working";
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] one")).toBe("delivered");
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle", foreground: [] }];
  const before = sends().length;
  expect(await sendVerified(at(T0).run, at(T0).clock, "w:p1", "[LEAD] two")).toBe("failed");
  expect(sends().length).toBe(before);
});

test("a failed pane lookup is doubt: nothing is typed, the send fails", async () => {
  const deps = at(T0);
  const typed: (readonly string[])[] = [];
  const run = async (argv: readonly string[]) => {
    if (argv[0] === "hc" && argv[1] === "get") return { code: 1, out: "", err: "hc down" };
    if (argv[0] === "hc" && argv[1] === "send") typed.push(argv);
    return deps.run(argv);
  };
  expect(await sendVerified(run as typeof deps.run, deps.clock, "w:p1", "[LEAD] please report")).toBe("failed");
  expect(typed).toHaveLength(0);
});

test("text with a backtick never reaches a pane", async () => {
  await expect(sendVerified(at(T0).run, at(T0).clock, "w:p1", "run `rm -rf`")).rejects.toBeInstanceOf(UnsafeTextError);
  expect(world.calls).toHaveLength(0);
});
