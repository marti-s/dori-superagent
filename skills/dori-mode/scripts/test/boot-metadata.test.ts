import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import type { Manifest, Monitor } from "../src/boot-monitors.ts";
import { type Lane, type LaneStatus, Registry } from "../src/registry.ts";
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

test("a manifest with a malformed monitor entry is named as unreadable and the check still finishes", async () => {
  // Given one manifest whose monitors list holds null and a string, and a valid manifest in another session.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("closed", "closed"));
  const bad = join(deps.sessionsDir, "a", "extensions", "terminal");
  const good = join(deps.sessionsDir, "b", "extensions", "terminal");
  mkdirSync(bad, { recursive: true });
  mkdirSync(good, { recursive: true });
  writeFileSync(join(bad, "null.json"), JSON.stringify({ version: 1, sessionId: "owner", monitors: [null] }));
  writeFileSync(join(bad, "string.json"), JSON.stringify({ version: 1, sessionId: "owner", monitors: ["mon_X"] }));
  writeFileSync(
    join(good, "owner.json"),
    JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_GOOD" }]).data),
  );
  // When boot runs; then both bad files are named, the good watch is still listed, and the run is incomplete.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`MONITORS unreadable ${join(bad, "null.json")}`);
  expect(result.lines).toContain(`MONITORS unreadable ${join(bad, "string.json")}`);
  expect(result.lines).toContain('STOP in the owner session only: kill_bash({"bash_id":"mon_GOOD"})');
  expect(result.exitCode).toBe(1);
});

test("expired and delivery-paused watches are listed apart from live ones, and an expired one gets no stop call", async () => {
  // Given a closed lane with a live, a delivery-paused and an expired persistent watch.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("closed", "closed"));
  const terminal = join(deps.sessionsDir, "lead", "extensions", "terminal");
  mkdirSync(terminal, { recursive: true });
  writeFileSync(
    join(terminal, "owner.json"),
    JSON.stringify(
      manifest([
        { command: "dori watch closed", monitorId: "mon_EXPIRED", expiresAt: T0 - 1 },
        { command: "dori watch closed", monitorId: "mon_PAUSED", expiresAt: T0 + 60_000, deliveryPaused: true },
        { command: "dori watch closed", monitorId: "mon_LIVE", expiresAt: T0 + 60_000 },
      ]).data,
    ),
  );
  // When boot runs.
  const result = await bootCheck(deps);
  const watchLines = result.lines.filter((l) => /^(MONITORS cleanup|CLEANUP|STOP|EXPIRED)/.test(l));
  const owner = `ownerSession=owner metadata=${join(terminal, "owner.json")}`;
  // Then live comes first, the paused one is flagged, and the expired one is listed without a stop call.
  expect(watchLines).toEqual([
    "MONITORS cleanupCandidates=2 deliveryPaused=1 expired=1 (from metadata; liveness unverified)",
    `CLEANUP closed match=closed:command:key ${owner}`,
    'STOP in the owner session only: kill_bash({"bash_id":"mon_LIVE"})',
    `CLEANUP closed match=closed:command:key ${owner} deliveryPaused=true`,
    'STOP in the owner session only: kill_bash({"bash_id":"mon_PAUSED"})',
    `EXPIRED closed match=closed:command:key ${owner} expiresAt=${new Date(T0 - 1).toISOString()}; nothing to stop`,
  ]);
});

test("dori boot reads the current session's terminal metadata from PI_SESSION_DIR and PI_SESSION_FILE", async () => {
  // Given a closed lane and one watch on it in each of the two env-named session directories, outside sessionsDir.
  const home = join(state.dir, "home");
  const stateDir = join(state.dir, "state");
  const current = join(state.dir, "current", "extensions", "terminal");
  const fileDir = join(state.dir, "other", "extensions", "terminal");
  for (const dir of [home, current, fileDir]) mkdirSync(dir, { recursive: true });
  await new Registry(stateDir).write(lane("closed", "closed"));
  writeFileSync(
    join(current, "a.json"),
    JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_SESSIONDIR" }]).data),
  );
  writeFileSync(
    join(fileDir, "b.json"),
    JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_SESSIONFILE" }]).data),
  );
  // When the real CLI runs boot with no Slack token and no hc on PATH.
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "boot"], {
    env: {
      HOME: home,
      PATH: dirname(process.execPath),
      TMPDIR: state.dir,
      DORI_TELEMETRY: "0",
      DORI_CONFIG: join(home, "none.json"),
      DORI_STATE_DIR: stateDir,
      DORI_LEAD_PANE: "w9:p1",
      PI_SESSION_DIR: join(state.dir, "current"),
      PI_SESSION_FILE: join(state.dir, "other", "session.jsonl"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  // Then both directories were read, Slack was skipped, and the missing pane list makes the run incomplete.
  expect(out).toContain(
    `CLEANUP closed match=closed:command:key ownerSession=owner metadata=${join(current, "a.json")}`,
  );
  expect(out).toContain(
    `CLEANUP closed match=closed:command:key ownerSession=owner metadata=${join(fileDir, "b.json")}`,
  );
  expect(out).toContain("SLACK skipped (DORI_SLACK_TOKEN not set)");
  expect(out).toContain("PANES unavailable (session list failed)");
  expect(code).toBe(1);
});

test("one unreadable metadata file is named and the other sessions' cleanup is still listed, path quoted", async () => {
  // Given a corrupt manifest in one session and a valid one, in a directory with a space, in another.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("closed", "closed"));
  const bad = join(deps.sessionsDir, "a", "extensions", "terminal");
  const good = join(deps.sessionsDir, "b session", "extensions", "terminal");
  mkdirSync(bad, { recursive: true });
  mkdirSync(good, { recursive: true });
  writeFileSync(join(bad, "owner.json"), "{partial");
  writeFileSync(
    join(good, "owner.json"),
    JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_GOOD" }]).data),
  );
  // When boot runs.
  const result = await bootCheck(deps);
  // Then the bad file is named, the good one still yields its stop call, and its path is shell-quoted.
  expect(result.lines).toContain(`MONITORS unreadable ${join(bad, "owner.json")}`);
  expect(result.lines).toContain(
    `CLEANUP closed match=closed:command:key ownerSession=owner metadata='${join(good, "owner.json")}'`,
  );
  expect(result.lines).toContain('STOP in the owner session only: kill_bash({"bash_id":"mon_GOOD"})');
  expect(result.exitCode).toBe(1);
});
