import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Every directory and file under the state dir, with file bytes, so a created directory counts as a write too.
const snapshot = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => [
      join(e.parentPath, e.name),
      e.isFile() ? readFileSync(join(e.parentPath, e.name), "utf8") : e.isDirectory() ? "<dir>" : "<other>",
    ])
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));

const bootDeps = (world: World, slack: () => Promise<{ userId: string; teamId: string } | null> = async () => null) => {
  const sessionsDir = join(state.dir, "sessions");
  const deps = depsFor(world, fakeClock(T0), state.dir, { sessionsDir, leadPane: "w2:p1" });
  return { ...deps, reports: new Reports(state.dir), worklog: new Worklog(state.dir), slack, sessionsDir };
};

test("boot reports vanished panes, journals and stale watches, and writes nothing", async () => {
  // Given a lane whose pane vanished, a live lane, a closed lane with a watch, and a halted journal.
  const world = newWorld();
  world.panes = [
    { pane_id: "w2:p1", workspace_id: "w2" },
    { pane_id: "w2:p2", workspace_id: "w2" },
  ];
  const deps = bootDeps(world, async () => ({ userId: "U_FIXTURE", teamId: "T_FIXTURE" }));
  for (const l of [
    launched("api-release", "working", "w1:p8"),
    lane("live", "working", "w2:p2"),
    lane("closed", "closed"),
  ])
    await deps.registry.write(l);
  deps.reports.report("api-release", "halted", "work pushed, waiting for the owner", T0);
  const terminal = join(deps.sessionsDir, "lead", "extensions", "terminal");
  mkdirSync(terminal, { recursive: true });
  writeFileSync(
    join(terminal, "owner.json"),
    JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_REALFIXTURE" }]).data),
  );
  const before = snapshot(state.dir);
  // When boot runs.
  const result = await bootCheck(deps);
  // Then every finding is printed, the vanished open lane fails the boot as drift, and no file changed.
  expect(result.exitCode).toBe(1);
  expect(result.lines).toContain("DRIFT n=1 api-release");
  expect(result.lines).toContain(
    "SLACK authenticated user=U_FIXTURE team=T_FIXTURE (auth.test only; inbox delivery unverified)",
  );
  expect(result.lines).toContain(
    "VANISHED api-release pane=w1:p8 status=working; registry and worktrees preserved; no relaunch",
  );
  expect(result.lines).toContain("UNREGISTERED w2:p1");
  expect(result.lines).toContain(
    "REPORT api-release kind=halted at=2026-01-01T12:00:00.000Z state=halted registryStatus=working",
  );
  expect(result.lines).toContain('STOP in the owner session only: kill_bash({"bash_id":"mon_REALFIXTURE"})');
  expect(result.lines.some((l) => l.startsWith("VANISHED closed"))).toBe(false);
  expect(snapshot(state.dir)).toEqual(before);
  expect(world.calls.every((c) => c[0] === "herdr" && c[1] === "pane" && ["list", "get"].includes(c[2] ?? ""))).toBe(
    true,
  );
});

test("boot on a state dir with no lanes directory leaves it byte-identical", async () => {
  // Given a state dir that has never held a lane.
  const world = newWorld();
  const deps = bootDeps(world);
  writeFileSync(join(state.dir, "messenger.json"), "{}");
  const before = snapshot(state.dir);
  // When boot runs; then it finishes clean and creates no lanes directory or anything else.
  const result = await bootCheck(deps);
  expect(result.exitCode).toBe(0);
  expect(snapshot(state.dir)).toEqual(before);
});

test("a closed lane owns no pane, so a pane left behind by a failed close is unregistered", async () => {
  // Given a closed lane whose pane is still open, and a working lane on a live pane.
  const world = newWorld();
  world.panes = [
    { pane_id: "w2:p1", workspace_id: "w2" },
    { pane_id: "w2:p2", workspace_id: "w2" },
    { pane_id: "w2:p3", workspace_id: "w2" },
  ];
  const deps = bootDeps(world);
  await deps.registry.write(lane("gone", "closed", "w2:p3"));
  await deps.registry.write(lane("current", "working", "w2:p2"));
  // When boot runs; then the leftover pane is listed and only the open lane counts as registered.
  const result = await bootCheck(deps);
  expect(result.lines).toContain("PANES lead=w2:p1 leadState=live registeredLive=1 vanished=0 unregistered=2");
  expect(result.lines).toContain("UNREGISTERED w2:p1 w2:p3");
});

test("an unreadable lane file is named and the other lanes are still checked", async () => {
  // Given a partial lane record next to a lane whose pane vanished.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("healthy", "working", "w1:gone"));
  writeFileSync(deps.registry.path("broken"), "{partial");
  writeFileSync(deps.registry.path("null-record"), "null");
  // When boot runs; then the file is named, the healthy lane is still reported, and the run is incomplete.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`REGISTRY unreadable ${deps.registry.path("broken")}`);
  expect(result.lines).toContain(`REGISTRY unreadable ${deps.registry.path("null-record")}`);
  expect(result.lines).toContain(
    "VANISHED healthy pane=w1:gone status=working; registry and worktrees preserved; no relaunch",
  );
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});

test("a lanes path that cannot be listed is named and the rest of boot still runs", async () => {
  // Given a lanes path that is a file, not a directory.
  const world = newWorld();
  const deps = bootDeps(world);
  writeFileSync(join(state.dir, "lanes"), "not a directory");
  // When boot runs; then the registry is named unreadable and the later checks still print.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`REGISTRY unreadable ${join(state.dir, "lanes")}`);
  expect(result.lines.some((l) => l.startsWith("MONITORS cleanupCandidates="))).toBe(true);
  expect(result.exitCode).toBe(1);
});

test("a verified-done lane whose pane is gone is not flagged VANISHED", async () => {
  // Given a verified-done lane and a working lane, both on panes that no longer exist.
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }];
  const deps = bootDeps(world);
  await deps.registry.write(lane("verified", "verified-done", "w1:p7"));
  await deps.registry.write(lane("working", "working", "w1:p8"));
  // When boot runs; then only the working lane is flagged.
  const result = await bootCheck(deps);
  expect(result.lines.filter((l) => l.startsWith("VANISHED"))).toEqual([
    "VANISHED working pane=w1:p8 status=working; registry and worktrees preserved; no relaunch",
  ]);
  expect(result.lines).toContain("PANES lead=w2:p1 leadState=live registeredLive=0 vanished=1 unregistered=1");
});

test("a journal-done lane whose pane is gone is finished in both checks: not VANISHED, and its watch is offered for cleanup", async () => {
  // Given a working lane whose journal says done, on a pane that no longer exists, with a persistent watch naming it.
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }];
  const deps = bootDeps(world);
  await deps.registry.write(launched("reported", "working", "w1:p9"));
  deps.reports.report("reported", "done", "finished", T0);
  const terminal = join(deps.sessionsDir, "lead", "extensions", "terminal");
  mkdirSync(terminal, { recursive: true });
  writeFileSync(
    join(terminal, "owner.json"),
    JSON.stringify(manifest([{ command: "dori watch reported", monitorId: "mon_REPORTED" }]).data),
  );
  // When boot runs; then the lane is not flagged and its watch is a cleanup candidate.
  const result = await bootCheck(deps);
  expect(result.lines.some((l) => l.startsWith("VANISHED"))).toBe(false);
  expect(result.lines).toContain("PANES lead=w2:p1 leadState=live registeredLive=0 vanished=0 unregistered=1");
  expect(result.lines).toContain(
    "MONITORS cleanupCandidates=1 deliveryPaused=0 expired=0 (from metadata; liveness unverified)",
  );
  expect(result.lines).toContain('STOP in the owner session only: kill_bash({"bash_id":"mon_REPORTED"})');
});

test("a failed pane list stays unknown instead of declaring every lane vanished", async () => {
  // Given herdr failing to list panes.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("active"));
  const failing = { ...deps, run: async () => ({ code: 1, out: "", err: "server not running" }) };
  // When boot runs; then it is incomplete and no lane is called vanished.
  const result = await bootCheck(failing);
  expect(result.exitCode).toBe(1);
  expect(result.lines).toContain("PANES unavailable (session list failed)");
  expect(result.lines.some((line) => line.startsWith("VANISHED"))).toBe(false);
});

test("boot prints the runtime and where its choice came from as its first line", async () => {
  const world = newWorld();
  const deps = { ...bootDeps(world), env: { DORI_RUNTIME: "herdr" } };
  const result = await bootCheck(deps);
  expect(result.lines[0]).toBe("RUNTIME herdr (from env)");
  expect(result.exitCode).toBe(0);
});

test("a runtime choice that fails is printed first as RUNTIME unavailable and fails boot", async () => {
  const world = newWorld();
  const deps = { ...bootDeps(world), env: { DORI_RUNTIME: "tmux" } };
  const result = await bootCheck(deps);
  expect(result.lines[0]).toStartWith("RUNTIME unavailable: ");
  expect(result.lines[0]).toContain("tmux");
  expect(result.exitCode).toBe(1);
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
});
