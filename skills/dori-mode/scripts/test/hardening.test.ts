import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { run } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

const MIN = 60_000;

const lane: Lane = {
  key: "hardening-qa",
  title: "QA",
  thread: "none",
  pane: "qa:p1",
  brief: "/b.md",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
  reportProtocol: "jsonl-v1",
};

test("freshness keeps a hung timer stalled without duplicate transitions or alerts", async () => {
  // Given the full freshness path and a running timer.
  const state = withState();
  try {
    const world = newWorld(),
      clock = fakeClock(T0);
    const deps = depsFor(world, clock, state.dir, { nudgeAfterMin: 999, supervision: { gitActivity: false } });
    await deps.registry.write(lane);
    const reports = new Reports(state.dir);
    reports.report(lane.key, "milestone", "started", T0);
    world.screen = "Working (21m 0s)\n❯ ";
    expect(await freshnessTick(deps, "/home/test")).toEqual([]);
    // When the same timer grows beyond the no-activity threshold.
    clock.at += 20 * MIN;
    world.screen = "Working (41m 0s)\n❯ ";
    expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["stalled"]);
    const captured = readFileSync(reports.path(lane.key), "utf8");
    clock.at += MIN;
    world.screen = "Working (42m 0s)\n❯ ";
    // Then the legacy Working observer cannot undo the stall every sweep.
    expect(await freshnessTick(deps, "/home/test")).toEqual([]);
    expect(readFileSync(reports.path(lane.key), "utf8")).toBe(captured);
    expect(reports.read(lane.key)?.state).toBe("stalled");
    expect(world.calls.some((c) => c.includes("close") || c.includes("send-text"))).toBe(false);
  } finally {
    state.done();
  }
});

test("freshness persists a wall ceiling blocker without sending or terminating", async () => {
  // Given a new lane at its configured ceiling.
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0 + MIN), state.dir, {
      supervision: { defaults: { wallMinutes: 1 }, gitActivity: false },
    });
    await deps.registry.write(lane);
    new Reports(state.dir).report(lane.key, "milestone", "started", T0);
    // When the regular freshness command runs its supervision step.
    const result = await freshnessTick(deps, "/home/test");
    // Then state and alert agree, and only a pane read was needed.
    expect(result.map((a) => a.kind)).toEqual(["blocked"]);
    expect(new Reports(state.dir).read(lane.key)?.state).toBe("blocked");
    expect(world.calls.every((c) => c[0] === "hc" && c[2] === "read")).toBe(true);
  } finally {
    state.done();
  }
});

test("a launched lane with no report journal is not supervised by freshness", async () => {
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0 + MIN), state.dir, {
      nudgeAfterMin: 999,
      supervision: { defaults: { wallMinutes: 1 }, gitActivity: false },
    });
    await deps.registry.write(lane);
    world.screen = "Working (41m 0s)\n❯ ";
    expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).not.toContain("blocked");
    expect(existsSync(join(state.dir, "lanes", lane.key, "supervision.json"))).toBe(false);
    expect(existsSync(new Reports(state.dir).path(lane.key))).toBe(false);
  } finally {
    state.done();
  }
});

test("a usage warning does not hide the idle-prompt stall of the same lane", async () => {
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0 + 20 * MIN), state.dir, {
      nudgeAfterMin: 15,
      supervision: { defaults: { tokens: 1000 }, gitActivity: false },
    });
    await deps.registry.write(lane);
    new Reports(state.dir).report(lane.key, "milestone", "started", T0);
    world.screen = "all done here\n❯ ";
    const acts = await freshnessTick(deps, "/home/test");
    expect(acts.map((a) => a.kind)).toEqual(["warning", "stalled"]);
    expect(acts[0]?.detail).toBe("tokens ceiling cannot be checked: usage unavailable");
  } finally {
    state.done();
  }
});

test("Runner preserves leading status columns and NUL delimiters when requested", async () => {
  // Given git-like machine output; when passed through the actual runner.
  const result = await run([process.execPath, "-e", 'process.stdout.write(" M source.ts\\u0000")'], {
    preserveOutput: true,
  });
  // Then activity parsers receive the first filename without truncation.
  expect(result.code).toBe(0);
  expect(result.out).toBe(" M source.ts\0");
});
