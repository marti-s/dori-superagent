import { afterEach, beforeEach, expect, test } from "bun:test";

import type { DoriConfig } from "../src/config.ts";
import { adoptLane } from "../src/launch-adopt.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const adoptedRef = async (runtime: NonNullable<DoriConfig["runtime"]>, pane: string) => {
  const deps = depsFor(world, fakeClock(T0), state.dir, { runtime });
  const key = `adopted-${runtime}`;
  await adoptLane(deps, { key, title: "t", brief: "/b.md", done: "closed acme/app#3", pane });
  const lane = await deps.registry.read(key);
  return { sessionRef: lane?.sessionRef, pane: lane?.pane };
};

test("a bare pane id adopted on an hc config is recorded as an hc session (#222)", async () => {
  expect(await adoptedRef("hc", "t4q")).toEqual({ sessionRef: { runtime: "hc", id: "t4q" }, pane: "t4q" });
});

test("a bare pane id adopted on a herdr config is recorded as a herdr pane", async () => {
  expect(await adoptedRef("herdr", "t4q")).toEqual({ sessionRef: { runtime: "herdr", id: "t4q" }, pane: "t4q" });
});

test("an explicit runtime prefix wins over the configured runtime", async () => {
  expect(await adoptedRef("hc", "herdr:w1:p3")).toEqual({
    sessionRef: { runtime: "herdr", id: "w1:p3" },
    pane: "w1:p3",
  });
  expect(await adoptedRef("herdr", "hc:t7")).toEqual({ sessionRef: { runtime: "hc", id: "t7" }, pane: "t7" });
});
