import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchLane } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

test("a lane's terminal starts with the env the launch chose, never with the launcher's other DORI_* variables", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  // The runtime sees the launcher's whole environment, an allow flag and a foreign home included.
  const env = {
    DORI_SLACK_TOKEN_FILE_ALLOW_OUTSIDE: "1",
    DORI_HOME: "/someone/else",
    PATH: "/a:/b",
    SHELL: "/bin/zsh",
  };
  const deps = { ...depsFor(world, fakeClock(T0), state.dir), env };
  await launchLane(deps, { key: "env-lane", title: "t", brief, done: "closed acme/app#3" });
  const run = world.calls.find((c) => c[0] === "hc" && c[2] === "run") ?? [];
  const started = run.slice(run.indexOf("env") + 1, -1);
  expect(run.at(-1)).toBe("/bin/zsh");
  expect(started.filter((kv) => /^(DORI_SLACK_TOKEN_FILE_ALLOW_OUTSIDE|DORI_HOME|PATH)=/.test(kv))).toEqual([]);
});
