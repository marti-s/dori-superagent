import { afterEach, beforeEach, expect, test } from "bun:test";

import { claimDone, closeLane, objectDone, watchTick } from "../src/done-flow.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World, WT } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const lane: Lane = {
  key: "demo-lane",
  title: "demo",
  thread: "chat:team/123",
  pane: "w:p1",
  brief: "/briefs/demo.md",
  done: "merged acme/app#1; closed acme/app#2",
  cwd: "/repo",
  openedAt: new Date(T0 - 60 * MIN).toISOString(),
};

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number) =>
  depsFor(world, fakeClock(ms), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
/** Every close of a session: hc is asked to kill the terminal before it removes it. */
const closedVia = () => world.calls.filter((c) => c[0] === "hc" && c[2] === "kill");

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
  expect(closedVia()).toEqual([["hc", "--json", "kill", "w:p1"]]);
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
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([
    `unpushed work in ${WT} (git state unreadable)`,
  ]);
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
