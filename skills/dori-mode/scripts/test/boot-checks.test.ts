import { afterEach, beforeEach, expect, test } from "bun:test";
import type { DoriConfig } from "../src/config.ts";
import { bootCheck } from "../src/boot.ts";
import type { Lane, LaneStatus } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { Worklog } from "../src/worklog.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

const lane = (key: string, status: LaneStatus, ref: Lane["sessionRef"]): Lane => ({
  key,
  status,
  ...(ref ? { sessionRef: ref, pane: ref.id } : {}),
  title: key,
  thread: "none",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: new Date(T0).toISOString(),
});

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const boot = async (world: World, patch: Partial<DoriConfig>, lanes: Lane[] = []) => {
  const deps = depsFor(world, fakeClock(T0), state.dir, { leadPane: "w2:p1", ...patch });
  for (const l of lanes) await deps.registry.write(l);
  return bootCheck({
    ...deps,
    reports: new Reports(state.dir),
    worklog: new Worklog(state.dir),
    slack: async () => null,
    monitorDirs: [],
  });
};

const agent = (pane_id: string, workspace_id: string) => ({
  pane_id,
  workspace_id,
  agent: "omo",
  agent_status: "working",
});

test("a workspace filter that leaves out laneWorkspace is a CONFIG_WARN and fails boot", async () => {
  // Given a filter naming an old workspace while new lanes open in w2.
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }];
  // When boot runs; then the mismatch is one line and the exit is non-zero.
  const result = await boot(world, { workspaces: ["w1"], laneWorkspace: "w2" });
  expect(result.lines).toContain("CONFIG_WARN workspaces=[w1] does not include laneWorkspace=w2");
  expect(result.exitCode).toBe(1);
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
});

test("live agents on herdr that no filtered workspace matches are a CONFIG_WARN", async () => {
  // Given no laneWorkspace configured to compare, and agents running only outside the filtered workspace.
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }, agent("w3:p1", "w3"), agent("w3:p2", "w3")];
  // When boot runs; then the filter is named as matching none of them.
  const result = await boot(world, { workspaces: ["w1"] });
  expect(result.lines).toContain("CONFIG_WARN workspaces=[w1] match none of the 2 live agent sessions on herdr");
  expect(result.exitCode).toBe(1);
});

test("a filter that covers the agents, or no filter at all, stays quiet", async () => {
  // Given agents in the filtered lane workspace, an agent elsewhere, and the lead in its own workspace.
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }, agent("w3:p1", "w3"), agent("w4:p1", "w4")];
  // When boot runs with the filter including laneWorkspace, and again with no filter.
  for (const patch of [{ workspaces: ["w3"], laneWorkspace: "w3" }, { workspaces: [] }]) {
    const result = await boot(world, patch);
    // Then no CONFIG_WARN is printed and the boot is clean.
    expect(result.lines.some((l) => l.startsWith("CONFIG_WARN"))).toBe(false);
    expect(result.exitCode).toBe(0);
  }
});

test("DRIFT counts open lanes whose pane herdr reports gone; closed and live lanes are not counted", async () => {
  // Given two open lanes on vanished panes, one closed lane on a vanished pane, and one lane on a live pane.
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }, agent("w2:p5", "w2")];
  const lanes = [
    lane("stale-a", "working", { runtime: "herdr", id: "w1:p8" }),
    lane("stale-b", "not-done", { runtime: "herdr", id: "w1:p9" }),
    lane("old", "closed", { runtime: "herdr", id: "w1:p7" }),
    lane("live", "working", { runtime: "herdr", id: "w2:p5" }),
  ];
  // When boot runs; then one DRIFT line counts the two, and the boot fails.
  const result = await boot(world, {}, lanes);
  expect(result.lines).toContain("DRIFT n=2 stale-a stale-b");
  expect(result.exitCode).toBe(1);
  // And only the vanished open lanes were probed.
  const probed = world.calls.filter((c) => c[0] === "herdr" && c[2] === "get").map((c) => c[3]);
  expect(probed.sort()).toEqual(["w1:p8", "w1:p9"]);
});

test("a verified-done lane on a gone pane is not drift, as it is not VANISHED (crash before the closed write)", async () => {
  // Given a lane settled as verified-done whose pane was closed before its status reached closed.
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }];
  const result = await boot(world, {}, [lane("settled", "verified-done", { runtime: "herdr", id: "w1:p8" })]);
  // Then boot neither flags nor probes it.
  expect(result.lines).toContain("DRIFT n=0");
  expect(result.lines.some((l) => l.startsWith("VANISHED"))).toBe(false);
  expect(world.calls.some((c) => c[0] === "herdr" && c[2] === "get")).toBe(false);
});

test("on hc, DRIFT uses hc's own probe and the workspace check does not apply", async () => {
  // Given an hc runtime with a workspace filter (meaningless there), a live lane, and a lane whose terminal is gone.
  const world = newWorld();
  world.terminals = { t1: hcTerm() };
  const lanes = [
    lane("alive", "working", { runtime: "hc", id: "t1" }),
    lane("lost", "working", { runtime: "hc", id: "t9" }),
  ];
  // When boot runs.
  const result = await boot(world, { runtime: "hc", leadPane: "t1", workspaces: ["w1"], laneWorkspace: "w2" }, lanes);
  // Then the lost lane is drift, found by `hc get`, and no CONFIG_WARN is printed.
  expect(result.lines).toContain("DRIFT n=1 lost");
  expect(result.lines.some((l) => l.startsWith("CONFIG_WARN"))).toBe(false);
  expect(world.calls.some((c) => c[0] === "hc" && c[2] === "get" && c[3] === "t9")).toBe(true);
  expect(result.exitCode).toBe(1);
});

test("a probe that fails is named and fails boot, but is not counted as drift", async () => {
  // Given an hc lane, missing from the list, whose `hc get` errors instead of answering not_found.
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0), state.dir, { runtime: "hc", leadPane: "t1" });
  await deps.registry.write(lane("broken", "working", { runtime: "hc", id: "t3" }));
  const run = deps.run;
  const result = await bootCheck({
    ...deps,
    run: async (argv) =>
      argv[0] === "hc" && argv[2] === "get" && argv[3] === "t3" ? { code: 1, out: "", err: "boom" } : run(argv),
    reports: new Reports(state.dir),
    worklog: new Worklog(state.dir),
    slack: async () => null,
    monitorDirs: [],
  });
  // Then the failed probe is named, drift stays 0, and the boot is incomplete.
  expect(result.lines).toContain("DRIFT n=0");
  expect(result.lines.some((l) => l.startsWith("DRIFT probe-failed broken"))).toBe(true);
  expect(result.exitCode).toBe(1);
});
