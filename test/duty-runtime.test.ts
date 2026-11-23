import { describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import type { Lane } from "../src/store-types.ts";
import { terminal } from "./fake-hc.ts";
import { World } from "./fake.ts";

const REF: SessionRef = { runtime: "hc", id: "t1", group: "g" };
const lane = (over: Partial<Lane> = {}): Lane => ({
  key: "hc-lane",
  sessionRef: REF,
  paneId: "t1",
  tabId: "",
  brief: "/b.md",
  cwd: "/w",
  status: "working",
  createdAt: 0,
  lastActivityAt: 0,
  nudges: 0,
  log: [],
  ...over,
});

describe("the duty pass on hc lanes", () => {
  test("an agent in error waits like a blocked one: no nudge however long it is idle", async () => {
    const w = new World();
    const d = w.deps();
    w.hc.terminals.set("t1", terminal({ status: { state: "error", app: "omo" } }));
    d.store.saveLane(lane());
    w.clock = 60 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("hc-lane")!.nudges).toBe(0);
    expect(w.hc.sent).toEqual([]);
  });
});
