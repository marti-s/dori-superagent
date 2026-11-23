import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { launchLane } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { depsFor, fakeClock, hcCreated, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

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

test("launch persists default and per-lane ceilings with explicit override precedence", async () => {
  // Given a real brief and a fake external pane creator.
  const state = withState();
  try {
    const brief = join(state.dir, "brief.md");
    writeFileSync(brief, "Do the fixture work.");
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0), state.dir, {
      supervision: {
        defaults: { wallMinutes: 240, tokens: 1000, costUsd: null },
        lanes: { "hardening-qa": { tokens: 2000 } },
      },
    });
    const original = deps.run;
    const result = await launchLane(
      {
        ...deps,
        run: async (argv, opts) =>
          argv[0] === "hc" && argv[2] === "run" ? hcCreated(world, "qa:p1") : original(argv, opts),
      },
      {
        key: lane.key,
        title: "QA",
        brief,
        done: "merged acme/app#1",
        budget: { wallMinutes: null },
        activityPaths: ["src/file.ts"],
      },
    );
    // Then launched registry data, not prompt prose, pins the configured behavior.
    expect(result.lane.budget).toEqual({ wallMinutes: null, tokens: 2000, costUsd: null });
    expect((await deps.registry.read(lane.key))?.budget).toEqual({ wallMinutes: null, tokens: 2000, costUsd: null });
    expect((await deps.registry.read(lane.key))?.activityPaths).toEqual(["src/file.ts"]);
    expect(new Reports(state.dir).read(lane.key)?.state).toBe("running");
  } finally {
    state.done();
  }
});

test("a launch budget field passed as undefined keeps the configured ceiling; only null turns it off", async () => {
  const state = withState();
  try {
    const brief = join(state.dir, "brief.md");
    writeFileSync(brief, "Do the fixture work.");
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0), state.dir, {
      supervision: { defaults: { wallMinutes: 240, tokens: 1000, costUsd: 5 } },
    });
    const original = deps.run;
    const result = await launchLane(
      {
        ...deps,
        run: async (argv, opts) =>
          argv[0] === "hc" && argv[2] === "run" ? hcCreated(world, "qa:p1") : original(argv, opts),
      },
      { key: lane.key, title: "QA", brief, done: "merged acme/app#1", budget: { tokens: undefined, costUsd: null } },
    );
    expect(result.lane.budget).toEqual({ wallMinutes: 240, tokens: 1000, costUsd: null });
    expect((await deps.registry.read(lane.key))?.budget).toEqual({ wallMinutes: 240, tokens: 1000, costUsd: null });
  } finally {
    state.done();
  }
});

test("config rejects invalid ceilings and retains defaults when only one is overridden", async () => {
  // Given a concrete configuration boundary.
  const state = withState();
  try {
    const path = join(state.dir, "config.json");
    writeFileSync(path, JSON.stringify({ supervision: { defaults: { tokens: 4000 } } }));
    // When loaded, the other ceilings stay off (null) unless configured.
    expect((await loadConfig(path)).supervision.defaults).toEqual({ wallMinutes: null, tokens: 4000, costUsd: null });
    writeFileSync(path, JSON.stringify({ supervision: { defaults: { tokens: -1 } } }));
    // Then a typo cannot silently disable the budget.
    await expect(loadConfig(path)).rejects.toThrow("invalid supervision tokens");
    // A misspelt ceiling name would leave that ceiling off, so it is refused by name.
    for (const [supervision, message] of [
      [{ defaults: { toknes: 4000 } }, "invalid supervision defaults.toknes: unknown ceiling"],
      [{ lanes: { a: { costUSD: 5 } } }, "invalid supervision lanes.a.costUSD: unknown ceiling"],
      [{ default: { tokens: 4000 } }, "invalid supervision default: unknown setting"],
    ] as const) {
      writeFileSync(path, JSON.stringify({ supervision }));
      await expect(loadConfig(path)).rejects.toThrow(message);
    }
  } finally {
    state.done();
  }
});

test("config with a malformed supervision entry fails with a named error, not a TypeError", async () => {
  const state = withState();
  try {
    const path = join(state.dir, "config.json");
    for (const [supervision, message] of [
      [{ lanes: { a: null } }, "invalid supervision lanes.a"],
      [{ lanes: [] }, "invalid supervision lanes"],
      [{ usageArgv: "usage {key}" }, "invalid supervision usageArgv"],
      [{ recordCostArgv: ["record", 1] }, "invalid supervision recordCostArgv"],
      [{ activityPaths: "src" }, "invalid supervision activityPaths"],
      [{ gitActivity: "no" }, "invalid supervision gitActivity"],
      ["off", "invalid supervision"],
    ] as const) {
      writeFileSync(path, JSON.stringify({ supervision }));
      await expect(loadConfig(path)).rejects.toThrow(message);
    }
  } finally {
    state.done();
  }
});
