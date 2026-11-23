import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import type { Manifest, Monitor } from "../src/boot-monitors.ts";
import type { Lane, LaneStatus } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { Worklog } from "../src/worklog.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

const lane = (key: string, status: LaneStatus = "working", pane = `w1:${key}`): Lane => ({
  key,
  status,
  pane,
  title: key,
  thread: "none",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: new Date(T0).toISOString(),
});

const launched = (key: string, status: LaneStatus = "working", pane = `w1:${key}`): Lane => ({
  ...lane(key, status, pane),
  reportProtocol: "jsonl-v1",
});

const manifest = (monitors: Monitor[]): Manifest => ({
  path: "/fixture/extensions/terminal/owner.json",
  data: {
    version: 1,
    sessionId: "owner",
    monitors: monitors.map((m) => ({ sessionId: "owner", persistent: true, monitorId: "mon_FIXTURE", ...m })),
  },
});

let state: ReturnType<typeof withState>;

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

const bootDeps = (world: World, slack: () => Promise<{ userId: string; teamId: string } | null> = async () => null) => {
  const sessionsDir = join(state.dir, "sessions");
  const deps = depsFor(world, fakeClock(T0), state.dir, { sessionsDir, leadPane: "w2:p1" });
  return { ...deps, reports: new Reports(state.dir), worklog: new Worklog(state.dir), slack, sessionsDir };
};

test("a corrupt journal is reported for its lane and does not stop the check", async () => {
  // Given a lane whose journal ends in a partial write.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(launched("broken"));
  deps.reports.report("broken", "milestone", "started", T0);
  writeFileSync(deps.reports.path("broken"), `${readFileSync(deps.reports.path("broken"), "utf8")}{partial\n`);
  // When boot runs; then the lane is named with the error kind and no local path, the rest still runs, and the exit is incomplete.
  const result = await bootCheck(deps);
  expect(result.lines).toContain("JOURNAL-ERROR broken kind=invalid-journal");
  expect(result.lines.join("\n")).not.toContain(state.dir);
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});

test("the launch's activity record is not a report: a lane that never reported reads NO-REPORT", async () => {
  // Given a launched lane whose journal holds only the harness's launch activity.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(launched("quiet"));
  deps.reports.append({
    type: "activity",
    key: "quiet",
    at: new Date(T0).toISOString(),
    state: "running",
    text: "lane launched in w1:quiet",
  });
  // When boot runs; then the lane is listed as having no report, never with a REPORT line.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(
    "NO-REPORT quiet state=running registryStatus=working (journal holds harness activity only)",
  );
  expect(result.lines.some((l) => l.startsWith("REPORT quiet"))).toBe(false);
});

test("a launched lane with no journal at all reads NO-REPORT, never nothing", async () => {
  // Given a launched lane, on a live pane, that has not written reports.jsonl yet.
  const world = newWorld();
  world.panes = [{ pane_id: "w1:silent", workspace_id: "w1", agent: "omo", agent_status: "working" }];
  const deps = bootDeps(world);
  await deps.registry.write(launched("silent"));
  // When boot runs; then the lane is listed as having no journal, and that alone is not a failure.
  const result = await bootCheck(deps);
  expect(result.lines).toContain("NO-REPORT silent registryStatus=working (no journal)");
  expect(result.exitCode).toBe(0);
});

test("an adopted lane's journal is not read, so a done record there cannot offer its watch for cleanup", async () => {
  // Given an adopted lane (no reportProtocol) with a done record and a persistent watch naming it.
  const world = newWorld();
  world.panes = [{ pane_id: "w1:adopted", workspace_id: "w1" }];
  const deps = bootDeps(world);
  await deps.registry.write(lane("adopted"));
  deps.reports.report("adopted", "done", "finished", T0);
  const terminal = join(deps.sessionsDir, "lead", "extensions", "terminal");
  mkdirSync(terminal, { recursive: true });
  writeFileSync(
    join(terminal, "owner.json"),
    JSON.stringify(manifest([{ command: "dori watch adopted", monitorId: "mon_ADOPTED" }]).data),
  );
  // When boot runs; then the journal is ignored like freshness ignores it, and the watch is kept.
  const result = await bootCheck(deps);
  expect(result.lines.some((l) => /^(NO-)?REPORT adopted/.test(l))).toBe(false);
  expect(result.lines).toContain(
    "MONITORS cleanupCandidates=0 deliveryPaused=0 expired=0 (from metadata; liveness unverified)",
  );
  expect(result.exitCode).toBe(0);
});

test("an unreadable journal of any kind is that lane's error; the other lanes are still reported", async () => {
  // Given one lane whose journal path is a directory (not a ReportError) and one healthy lane.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(launched("a-broken"));
  await deps.registry.write(launched("b-healthy"));
  mkdirSync(deps.reports.path("a-broken"), { recursive: true });
  deps.reports.report("b-healthy", "blocker", "needs the owner", T0);
  // When boot runs; then both lanes are listed and the run finishes incomplete.
  const result = await bootCheck(deps);
  expect(result.lines).toContain("JOURNAL-ERROR a-broken kind=EISDIR");
  expect(result.lines.join("\n")).not.toContain(state.dir);
  expect(result.lines).toContain(
    "REPORT b-healthy kind=blocker at=2026-01-01T12:00:00.000Z state=blocked registryStatus=working",
  );
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});
