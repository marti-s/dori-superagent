import { afterEach, beforeEach, expect, test } from "bun:test";
import { deadPaneTick, newDeadPaneState } from "../src/dead-panes.ts";
import { freshnessTick, lastReportLine } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { runtimesFor } from "../src/run.ts";
import { syncRegistry } from "../src/sync.ts";
import { hcTerm } from "./hc-runner.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

const MIN = 60_000;

let state: ReturnType<typeof withState>;

let world: World;

beforeEach(() => {
  state = withState();
  world = newWorld();
});

afterEach(() => state.done());

const working: Lane = {
  key: "quiet-lane",
  title: "quiet",
  thread: "chat:team/9",
  pane: "w:p7",
  brief: "/b.md",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
  lastReplyAt: T0,
};

test("a lane silent past the nudge time is nudged once, then its last report is posted for it", async () => {
  const deps = (ms: number) =>
    depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write(working);
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.screen = "noise\n[REPORT] quiet-lane | milestone | tests green on /home/test/repo, PR open\n❯ ";
  expect(await freshnessTick(deps(T0 + 10 * MIN), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 16 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  expect((await freshnessTick(deps(T0 + 17 * MIN), "/home/test")).map((a) => a.kind)).toEqual([]);
  expect((await freshnessTick(deps(T0 + 21 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["pending-report"]);
  expect(world.calls.find((c) => c[0] === "notify")).toBeUndefined();
  const posted = await freshnessTick(deps(T0 + 26 * MIN), "/home/test");
  expect(posted.map((a) => a.kind)).toEqual(["posted"]);
  const call = world.calls.find((c) => c[0] === "notify");
  expect(call?.[1]).toBe("chat:team/9");
  expect(call?.[2]).toContain("tests green on ~/repo, PR open");
  expect(sent(world)).toHaveLength(1);
});

test("a stopped agent pane is reported once per hour and the lead pane is never reported", async () => {
  world.panes = [
    { pane_id: "w:p1", workspace_id: "w" },
    { pane_id: "lead:p1", workspace_id: "lead" },
  ];
  world.screen = "omo has stopped\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const seen = new Set<string>();
  const st = newDeadPaneState();
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual(["DEAD_PANE w:p1"]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T13", st)).toEqual(["DEAD_PANE w:p1"]);
});

test("with workspaces set, herdr panes are still filtered by their workspace", async () => {
  world.panes = [
    { pane_id: "w:p1", workspace_id: "w" },
    { pane_id: "x:p2", workspace_id: "x" },
  ];
  world.screen = "omo has stopped\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir, { workspaces: ["w"] });
  const st = newDeadPaneState();
  const tick = () => deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", st);
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual(["DEAD_PANE w:p1"]);
});

test("with workspaces set, hc lanes in a watched dori.group are reported and the others are not (#196)", async () => {
  const stopped = { status: null, foreground: null, screen: "omo has stopped\n$ " };
  world.terminals = {
    t1: hcTerm({ ...stopped, labels: { "dori.group": "lanes" } }),
    t2: hcTerm({ ...stopped, labels: { "dori.group": "other" } }),
  };
  const deps = depsFor(world, fakeClock(T0), state.dir, { runtime: "hc", workspaces: ["lanes"] });
  const rts = runtimesFor(deps.config, {}, deps.run);
  const st = newDeadPaneState();
  const tick = () => deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", st, rts);
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual(["DEAD_PANE t1"]);
});

test("with workspaces set, sync lists an unregistered hc agent in a watched dori.group and skips the others", async () => {
  world.terminals = {
    t1: hcTerm({ labels: { "dori.group": "lanes" } }),
    t2: hcTerm({ labels: { "dori.group": "other" } }),
  };
  const deps = depsFor(world, fakeClock(T0), state.dir, { runtime: "hc", workspaces: ["lanes"] });
  const { unregistered } = await syncRegistry({ ...deps, rts: runtimesFor(deps.config, {}, deps.run) }, false);
  expect(unregistered.map((row) => row.pane)).toEqual(["t1"]);
});

test("a reworded stop message is not dead: with no alive status it is unrecognised, and repeated reads raise one alert", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  world.screen = "the agent process went away\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const seen = new Set<string>();
  const st = newDeadPaneState();
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual([
    "UNRECOGNISED_PANE w:p1 dead-panes: no alive status and no dead marker for 3 ticks",
  ]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", st)).toEqual([]);
});

test("a pane whose agent status says it is alive is never reported dead, whatever the screen shows", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "working" }];
  world.screen = "grep output: has stopped\n❯ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const st = newDeadPaneState();
  expect(await deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", st)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", st)).toEqual([]);
});

test("a dead marker that does not hold to the next tick is never dead", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  world.screens = ["omo has stopped\n$ ", "redrawing\n", "omo has stopped\n$ ", "redrawing\n"];
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const st = newDeadPaneState();
  for (let i = 0; i < 4; i++)
    expect(await deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", st)).toEqual([]);
});

test("an alive status resets the unrecognised count, so two unknown ticks on each side of it raise no alert", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  world.screen = "something else\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const st = newDeadPaneState();
  const tick = () => deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", st);
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([]);
  world.panes[0] = { pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" };
  expect(await tick()).toEqual([]);
  world.panes[0] = { pane_id: "w:p1", workspace_id: "w" };
  expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([]);
});

test("a posted [REPORT] line is saved: the same line on later ticks is stale, logged once, and never posted again", async () => {
  const deps = (ms: number) =>
    depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write({ ...working, lastNudgeAt: T0 + MIN });
  world.screen = "[REPORT] quiet-lane | milestone | tests green\n❯ ";
  expect((await freshnessTick(deps(T0 + 21 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["pending-report"]);
  expect((await freshnessTick(deps(T0 + 26 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["posted"]);
  const lane = await deps(T0).registry.read("quiet-lane");
  await deps(T0).registry.write({ ...lane!, lastReplyAt: T0 + 30 * MIN, lastNudgeAt: T0 + 31 * MIN });
  expect((await freshnessTick(deps(T0 + 55 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["stale-report"]);
  expect(await freshnessTick(deps(T0 + 60 * MIN), "/home/test")).toEqual([]);
  expect(await freshnessTick(deps(T0 + 65 * MIN), "/home/test")).toEqual([]);
  expect(world.calls.filter((c) => c[0] === "notify")).toHaveLength(1);
});

test("a quiet lane with no [REPORT] line logs NO-REPORT once, not on every tick", async () => {
  const deps = (ms: number) =>
    depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write({ ...working, lastNudgeAt: T0 + MIN });
  world.screen = "just thinking\n❯ ";
  expect((await freshnessTick(deps(T0 + 21 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["no-report"]);
  expect(await freshnessTick(deps(T0 + 26 * MIN), "/home/test")).toEqual([]);
  expect(await freshnessTick(deps(T0 + 31 * MIN), "/home/test")).toEqual([]);
});

test("a [REPORT] template with an unfilled placeholder is source, not a report: the last emitted report wins (#22)", () => {
  const emitted = "[REPORT] demo-lane | milestone | checks passed";
  const screen = [
    emitted,
    'print(f"[REPORT] demo-lane | milestone | {message}")',
    'echo "[REPORT] demo-lane | milestone | ${message}"',
  ].join("\n");
  expect(lastReportLine(screen, "demo-lane")).toBe(emitted);
  expect(lastReportLine('echo "[REPORT] demo-lane | done | ${message}"', "demo-lane")).toBeNull();
  expect(lastReportLine("[REPORT] demo-lane | done | PR #12 merged", "demo-lane")).toBe(
    "[REPORT] demo-lane | done | PR #12 merged",
  );
  expect(lastReportLine("[REPORT] demo-lane | milestone | added getUser({id}) and ${HOME} docs", "demo-lane")).toBe(
    "[REPORT] demo-lane | milestone | added getUser({id}) and ${HOME} docs",
  );
});
