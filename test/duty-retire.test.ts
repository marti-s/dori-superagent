import { describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import { tabCloseMinutes } from "../src/harness.ts";
import { done, ready, report, startLane } from "../src/lanes.ts";
import { sref } from "./fake.ts";
import { setup } from "./harness-setup.ts";

const MIN = 60_000;
const retired = (events: Awaited<ReturnType<typeof dutyTick>>) => events.filter((e) => e.action === "retired");

describe("retiring finished lanes", () => {
  test("a done lane's terminal and tab are closed 15 minutes later, not before, and the close is logged", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "shipped", brief);
    await ready(d, "shipped", "fixed", ["https://github.com/o/r/pull/1"]);
    await done(d, "shipped");
    w.clock += 14 * MIN;
    expect(retired(await dutyTick(d))).toEqual([]);
    expect(w.panes.has(lane.paneId)).toBe(true);
    w.clock += MIN;
    const text = `terminal ${lane.paneId} removed; tab tb-${lane.paneId} closed`;
    expect(await dutyTick(d)).toContainEqual({ lane: "shipped", action: "retired", detail: text });
    expect(w.panes.has(lane.paneId)).toBe(false);
    expect(w.hc.closedTabs.has(`tb-${lane.paneId}`)).toBe(true);
    expect(d.store.lane("shipped")).toMatchObject({ retiredAt: w.clock });
    expect(d.store.lane("shipped")?.log.at(-1)).toMatchObject({ kind: "retired", text });
    w.clock += 15 * MIN;
    expect(retired(await dutyTick(d))).toEqual([]);
  });

  test("an idle, waiting or READY-but-not-closed lane is never retired, however long it sits", async () => {
    const { w, d, brief } = setup();
    const idle = await startLane(d, "idle-lane", brief);
    const waiting = await startLane(d, "waiting-lane", brief);
    await report(d, "waiting-lane", "asked the lead a question", "waiting");
    const readyLane = await startLane(d, "ready-lane", brief);
    await ready(d, "ready-lane", "fixed", ["https://github.com/o/r/pull/2"]);
    const blocked = w.panes.get(waiting.paneId);
    if (blocked) blocked.status = "blocked";
    w.clock += 24 * 60 * MIN;
    expect(retired(await dutyTick(d))).toEqual([]);
    for (const lane of [idle, waiting, readyLane]) {
      expect(w.panes.get(lane.paneId)?.terminal.state).toBe("live");
      expect(w.hc.closedTabs.has(`tb-${lane.paneId}`)).toBe(false);
    }
    expect(w.hcCalls("kill")).toEqual([]);
    expect(d.store.lanes().map((l) => l.closedAt)).toEqual([undefined, undefined, undefined]);
  });

  test("a lane LOST to a finished terminal is retired after the delay too", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "crashed", brief);
    const pane = w.panes.get(lane.paneId);
    if (pane) pane.finished = true;
    expect(await dutyTick(d)).toContainEqual({ lane: "crashed", action: "lost" });
    w.clock += 15 * MIN;
    expect(retired(await dutyTick(d)).map((e) => e.lane)).toEqual(["crashed"]);
    expect(w.panes.has(lane.paneId)).toBe(false);
  });

  test("a lane restarted under its key before the delay is not retired, and its new terminal stays", async () => {
    const { w, d, brief } = setup();
    const first = await startLane(d, "again", brief);
    await done(d, "again", { note: "restarting" });
    w.clock += 5 * MIN;
    const second = await startLane(d, "again", brief);
    w.clock += 20 * MIN;
    expect(retired(await dutyTick(d))).toEqual([]);
    expect(w.panes.get(second.paneId)?.terminal.state).toBe("live");
    expect(w.hc.closedTabs.size).toBe(0);
    expect(w.panes.has(first.paneId)).toBe(true);
  });

  test("the lead's, duty's and the loops' terminals and tabs are never touched", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "near-lead", brief);
    // A lane sharing the duty tab with the duty loop, and a lane whose recorded terminal is the lead's (a bad record).
    w.addPane("t50", "idle");
    d.store.setRole("duty", sref("t50"));
    w.addPane("t51", "working");
    d.store.setRole("duty-loop", sref("t51"));
    for (const id of ["t50", "t51", lane.paneId]) w.hc.tabs.set(id, { id: "tb-duty", name: "duty" });
    await done(d, "near-lead", { note: "gone" });
    const leadLane = await startLane(d, "is-lead", brief);
    const record = d.store.lane("is-lead");
    if (record) d.store.saveLane({ ...record, sessionRef: sref("t1"), status: "done", closedAt: w.clock });
    w.clock += 15 * MIN;
    const events = await dutyTick(d);
    expect(events).toContainEqual({
      lane: "near-lead",
      action: "retired",
      detail: `terminal ${lane.paneId} removed; tab tb-duty kept: it holds live t50, t51`,
    });
    expect(events).toContainEqual({
      lane: "is-lead",
      action: "retired",
      detail: "kept: terminal t1 is the lead's, duty's or a loop's",
    });
    expect(w.hc.closedTabs.size).toBe(0);
    for (const id of ["t1", "t50", "t51", leadLane.paneId]) expect(w.panes.get(id)?.terminal.state).toBe("live");
  });

  test("a terminal at the lane's address that dori did not start for that lane is kept", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "reused", brief);
    await done(d, "reused", { note: "done" });
    // hc handed the address to someone else's terminal meanwhile.
    w.addPane(lane.paneId, "idle");
    w.clock += 15 * MIN;
    expect(await dutyTick(d)).toContainEqual({
      lane: "reused",
      action: "retired",
      detail: `kept: terminal ${lane.paneId} is not the one dori started for lane reused`,
    });
    expect(w.panes.get(lane.paneId)?.terminal.state).toBe("live");
    expect(w.hc.closedTabs.size).toBe(0);
  });

  test("a retire that fails is reported and tried again on the next pass", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "flaky", brief);
    await done(d, "flaky", { note: "x" });
    w.clock += 15 * MIN;
    w.hc.knobs.getError = "unavailable";
    expect(await dutyTick(d)).toContainEqual(expect.objectContaining({ lane: "flaky", action: "retire-failed" }));
    expect(d.store.lane("flaky")?.retiredAt).toBeUndefined();
    delete w.hc.knobs.getError;
    expect(retired(await dutyTick(d)).map((e) => e.lane)).toEqual(["flaky"]);
    expect(w.panes.has(lane.paneId)).toBe(false);
  });

  test("DORI_TAB_CLOSE_MIN of 0 never retires; unset is 15 minutes and a bad value is refused", async () => {
    expect(tabCloseMinutes(undefined)).toBe(15);
    expect(tabCloseMinutes("0")).toBe(0);
    expect(tabCloseMinutes("2.5")).toBe(2.5);
    for (const bad of ["-1", "later"]) expect(() => tabCloseMinutes(bad)).toThrow("0 or a positive number");
    const { w, d, brief } = setup();
    const off = { ...d, tabCloseDelayMs: 0 };
    const lane = await startLane(off, "kept", brief);
    await done(off, "kept", { note: "x" });
    w.clock += 24 * 60 * MIN;
    expect(retired(await dutyTick(off))).toEqual([]);
    expect(w.panes.has(lane.paneId)).toBe(true);
  });
});
