import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshnessTick } from "../src/freshness.ts";
import { launchLane } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

const MIN = 60_000;

let state: ReturnType<typeof withState>;

let world: World;

beforeEach(() => {
  state = withState();
  world = newWorld();
});

afterEach(() => state.done());

test("launch reports STARTUP_OK only on a ready agent status that shows a goal; a blank pane is unconfirmed, a known failure is an error", async () => {
  const brief = join(state.dir, "brief.md");
  // A status list is returned one per lookup, the last one repeating.
  let waits = 0;
  const run = async (
    status: string | undefined | (string | undefined)[],
    screen: string | string[],
    key: string,
    patch: { goalMarker?: string; startupWaitSeconds?: number } = {},
  ) => {
    const statuses = Array.isArray(status) ? [...status] : [status];
    writeFileSync(brief, "# brief\n");
    world = newWorld();
    if (Array.isArray(screen)) world.screens = [...screen];
    else world.screen = screen;
    waits = 0;
    const base = depsFor(world, { ...fakeClock(T0), sleep: async () => void waits++ }, state.dir, patch);
    const inner = base.run;
    const deps = {
      ...base,
      run: async (argv: readonly string[]) => {
        if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")
          return {
            code: 0,
            out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }),
            err: "",
          };
        if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list") {
          const s = statuses.length > 1 ? statuses.shift() : statuses[0];
          return {
            code: 0,
            out: JSON.stringify({
              result: {
                panes: [{ pane_id: "w:p9", workspace_id: "w", ...(s ? { agent: "pi", agent_status: s } : {}) }],
              },
            }),
            err: "",
          };
        }
        return inner(argv);
      },
    };
    return (await launchLane(deps, { key, title: "t", brief, done: "closed acme/app#3" })).startup;
  };
  const goal = "❯ \n Pursuing goal (1m)";
  expect(await run("idle", goal, "ok-lane")).toBe("STARTUP_OK ok-lane w:p9");
  expect(await run("working", ["❯ ", "❯ ", "❯ ", goal], "slow-goal-lane")).toBe("STARTUP_OK slow-goal-lane w:p9");
  expect(await run("idle", "❯ ", "no-goal-lane")).toStartWith("STARTUP_NO_GOAL no-goal-lane w:p9");
  expect(await run("idle", ["❯ ", "❯ ", "usage limit reached\n❯ "], "limit-lane")).toBe(
    "STARTUP_ERROR limit-lane w:p9: usage limit reached",
  );
  // A working agent has not failed: its own output may quote the failure phrases (here, while it reads launch.ts).
  expect(
    await run(
      "working",
      [
        "❯ ",
        "read launch.ts: /usage limit|rate limit|quota/\n❯ ",
        `read launch.ts: /usage limit|rate limit|quota/\n${goal}`,
      ],
      "quoting-lane",
    ),
  ).toBe("STARTUP_OK quoting-lane w:p9");
  expect(
    await run(
      "idle",
      `grep: ui.js returns "Pursuing goal" while active\n${"output\n".repeat(4)}❯ \n model • 10K`,
      "quoted-goal-lane",
    ),
  ).toStartWith("STARTUP_NO_GOAL quoted-goal-lane w:p9");
  expect(await run(["idle", "done"], ["❯ ", goal], "stopped-lane")).toStartWith(
    "STARTUP_UNCONFIRMED stopped-lane w:p9",
  );
  // The marker is config, since the agent is: another agent's goal line counts, and an empty marker turns the wait off.
  expect(await run("idle", "❯ \n goal: ship the fix", "other-agent-lane", { goalMarker: "goal:" })).toBe(
    "STARTUP_OK other-agent-lane w:p9",
  );
  expect(await run("idle", "❯ ", "no-marker-lane", { goalMarker: "" })).toBe("STARTUP_OK no-marker-lane w:p9");
  expect(waits).toBe(1);
  expect(await run(undefined, "", "blank-lane")).toStartWith("STARTUP_UNCONFIRMED blank-lane w:p9");
  expect(await run(undefined, "Error: provider refused the key\n$ ", "worded-lane")).toStartWith(
    "STARTUP_UNCONFIRMED worded-lane w:p9",
  );
  expect(await run("idle", "No API key found\n❯ ", "err-lane")).toBe("STARTUP_ERROR err-lane w:p9: No API key");
  expect(await run("blocked", "❯ ", "blocked-lane")).toStartWith("STARTUP_UNCONFIRMED blocked-lane w:p9");
  expect(await run("done", "❯ ", "done-lane")).toStartWith("STARTUP_UNCONFIRMED done-lane w:p9");

  // #202: omo starts despite a user extension it cannot load, so a line that is that warning is no start failure...
  const warning = `Warning: Failed to load extension "ext.js": Failed to load extension: Cannot find module '../gone.mjs'`;
  expect(await run("idle", [`${warning}\n❯ `, `${warning}\n${goal}`], "ext-warning-lane")).toBe(
    "STARTUP_OK ext-warning-lane w:p9",
  );
  // ...but a real missing module on another line of the same screen still is, with or without a status.
  const missing = `${warning}\nError: Cannot find module '/repo/dist/cli.js'\n$ `;
  expect(await run(undefined, missing, "module-lane")).toBe("STARTUP_ERROR module-lane w:p9: Cannot find module");
  expect(waits).toBe(1);
  expect(await run(["unknown", "unknown", "idle"], ["PS> & omo", missing], "late-module-lane")).toBe(
    "STARTUP_ERROR late-module-lane w:p9: Cannot find module",
  );
  expect(waits).toBe(2);
});

test("STARTUP_NO_GOAL names the time the launch really waited, not the planned 180 s", async () => {
  // Given a host where every sleep overruns by 5 s, and an agent that never shows a goal.
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  world.screen = "❯ ";
  const clock = fakeClock(T0);
  const base = depsFor(
    world,
    {
      ...clock,
      sleep: async (ms: number) => {
        clock.at += ms + 5_000;
      },
    },
    state.dir,
  );
  const inner = base.run;
  const deps = {
    ...base,
    run: async (argv: readonly string[]) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")
        return {
          code: 0,
          out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }),
          err: "",
        };
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list")
        return {
          code: 0,
          out: JSON.stringify({
            result: { panes: [{ pane_id: "w:p9", workspace_id: "w", agent: "pi", agent_status: "idle" }] },
          }),
          err: "",
        };
      return inner(argv);
    },
  };
  // When the launch gives up on the goal; then the message gives the 20 s check plus sixteen 10 s re-reads, each 5 s late.
  const { startup } = await launchLane(deps, { key: "late-lane", title: "t", brief, done: "closed acme/app#3" });
  expect(startup).toStartWith("STARTUP_NO_GOAL late-lane w:p9: the agent is running but shows no goal after 265 s;");
});

test("launch registers the lane before it starts the agent, so the lane's first dori report is accepted", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  const base = depsFor(world, fakeClock(T0), state.dir);
  let atStart: Lane | null | undefined;
  const deps = {
    ...base,
    run: async (argv: readonly string[]) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")
        return {
          code: 0,
          out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }),
          err: "",
        };
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run")
        atStart = await base.registry.read("fast-lane");
      return base.run(argv);
    },
  };
  await launchLane(deps, { key: "fast-lane", title: "t", brief, done: "closed acme/app#3" });
  expect(atStart?.pane).toBe("w:p9");
});

test("the harness launch record is not the lane's report: a silent launched lane is NO-REPORT, never posted", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  world.screen = "Working (1m)\n❯ ";
  const clock = fakeClock(T0);
  const base = depsFor(world, clock, state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  const deps = {
    ...base,
    run: async (argv: readonly string[]) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")
        return {
          code: 0,
          out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }),
          err: "",
        };
      return base.run(argv);
    },
  };
  await launchLane(deps, { key: "new-lane", title: "t", brief, done: "closed acme/app#3", thread: "chat:team/9" });
  clock.at = T0 + 21 * MIN;
  expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["nudged", "no-report"]);
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
});
