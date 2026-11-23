import { afterEach, beforeEach, expect, test } from "bun:test";

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

const adoptedRef = async (pane: string, key: string) => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await adoptLane(deps, { key, title: "t", brief: "/b.md", done: "closed acme/app#3", pane });
  const lane = await deps.registry.read(key);
  return { sessionRef: lane?.sessionRef, pane: lane?.pane };
};

test("a bare pane id is recorded as an hc session (#222)", async () => {
  expect(await adoptedRef("t4q", "bare")).toEqual({ sessionRef: { runtime: "hc", id: "t4q" }, pane: "t4q" });
});

test("the hc prefix names the same terminal as the bare address", async () => {
  expect(await adoptedRef("hc:t7", "prefixed")).toEqual({ sessionRef: { runtime: "hc", id: "t7" }, pane: "t7" });
});

test("an id that is no hc address is kept as given, a session on hc", async () => {
  expect(await adoptedRef("lead:p1", "other")).toEqual({
    sessionRef: { runtime: "hc", id: "lead:p1" },
    pane: "lead:p1",
  });
});
