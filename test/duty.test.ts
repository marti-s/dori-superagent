import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { send } from "../src/inbox.ts";
import { report, startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";
import { sref } from "./fake.ts";

describe("duty loop", () => {
  test("nudges an idle lane at 10 and 20 minutes, escalates at 40, and ignores WAITING lanes", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "quiet", brief, { group: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "idle";
    const at = async (min: number) => {
      w.clock = lane.createdAt + min * 60_000;
      return dutyTick(d);
    };
    expect(await at(5)).toEqual([]);
    expect(await at(10)).toContainEqual({ lane: "quiet", action: "nudge-1" });
    expect(pane.received.at(-1)).toContain("idle for 10 minutes");
    expect(await at(15)).toEqual([]);
    expect(await at(20)).toContainEqual({ lane: "quiet", action: "nudge-2" });
    expect(await at(40)).toContainEqual({ lane: "quiet", action: "escalated" });
    expect(lead.received.at(-1)).toContain("[ESCALATE quiet]");
    expect(await at(90)).toEqual([]);

    const waiting = await startLane(d, "blocked-on-ci", brief, { group: "w1" });
    w.panes.get(waiting.paneId)!.status = "idle";
    await report(d, "blocked-on-ci", "WAITING: CI", "waiting");
    w.clock += 60 * 60_000;
    expect((await dutyTick(d)).filter((e) => e.lane === "blocked-on-ci")).toEqual([]);
  });

  test("a failing inbox flush on one pane does not stop the loop for the other panes", async () => {
    const { w, d, lead } = setup();
    const broken = w.addPane("t9", "idle");
    w.sendFails.set("t9", "hc exploded");
    d.store.enqueue(sref("t9"), { at: w.clock, from: "cli", text: "to broken" });
    d.store.enqueue(sref("t1"), { at: w.clock, from: "cli", text: "to lead" });
    const events = await dutyTick(d);
    expect(events).toContainEqual({
      pane: "t9",
      action: "delivery-ambiguous",
      detail: expect.stringContaining("hc exploded"),
    });
    expect(events).toContainEqual({ pane: "t1", action: "flushed" });
    expect(lead.received.filter((m) => m.includes("to lead"))).toHaveLength(1);
    // The held batch is reported to the lead once (#111); the test is about the other pane still flushing, not about
    // the lead's inbox holding one message.
    expect(lead.received.filter((m) => m.includes("[DELIVERY-AMBIGUOUS t9]"))).toHaveLength(1);
    expect(broken.received).toEqual([]);
  });

  test("a failing lane-phase delivery is recorded as lane-failed and does not stop the other lanes", async () => {
    const { w, d, brief } = setup();
    const lost = await startLane(d, "lost-lane", brief, { group: "w1" });
    const stuck = await startLane(d, "stuck-lane", brief, { group: "w1" });
    const fine = await startLane(d, "fine-lane", brief, { group: "w1" });
    w.panes.delete(lost.paneId);
    w.panes.get(stuck.paneId)!.status = "idle";
    w.panes.get(fine.paneId)!.status = "idle";
    w.sendFails.set("t1", "lead exploded");
    w.sendFails.set(stuck.paneId, "stuck exploded");
    w.clock = fine.createdAt + 10 * 60_000;
    const events = await dutyTick(d);
    expect(events).toContainEqual({
      lane: "lost-lane",
      action: "lane-failed",
      detail: expect.stringContaining("lead exploded"),
    });
    expect(events).toContainEqual({
      lane: "stuck-lane",
      action: "lane-failed",
      detail: expect.stringContaining("stuck exploded"),
    });
    expect(events).toContainEqual({ lane: "fine-lane", action: "nudge-1" });
    expect(w.panes.get(fine.paneId)!.received.at(-1)).toContain("idle for 10 minutes");
  });

  test("a LOST notice the busy lead could not take at once reaches it on a later tick, exactly once", async () => {
    const { w, d, lead, brief } = setup();
    const gone = await startLane(d, "gone-lane", brief, { group: "w1" });
    lead.received.length = 0;
    w.panes.delete(gone.paneId);
    lead.status = "working";
    expect(await dutyTick(d)).toContainEqual({ lane: "gone-lane", action: "lost" });
    expect(lead.received).toEqual([]);
    lead.status = "idle";
    expect(await dutyTick(d)).toContainEqual({ pane: "t1", action: "flushed" });
    expect(lead.received.filter((m) => m.includes("[LOST gone-lane]"))).toHaveLength(1);
    expect(await dutyTick(d)).toEqual([]);
    expect(lead.received.filter((m) => m.includes("[LOST gone-lane]"))).toHaveLength(1);
  });

  test("the delivery-ambiguous detail is one line with hc's reason, never the queued message", async () => {
    const { w, d } = setup();
    w.addPane("t9", "idle");
    w.sendFails.set("t9", "hc exploded\nsecond line");
    d.store.enqueue(sref("t9"), { at: w.clock, from: "cli", text: "SECRET queued message" });
    const events = await dutyTick(d);
    expect(events).toEqual([
      { pane: "t9", action: "delivery-ambiguous", detail: expect.stringMatching(/^[^\n]*hc exploded$/) },
    ]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  test("the duty loop prints a delivery-ambiguous line with the reason", async () => {
    const { w, d } = setup();
    w.addPane("t9", "idle");
    w.sendFails.set("t9", "hc exploded");
    d.store.enqueue(sref("t9"), { at: w.clock, from: "cli", text: "to broken" });
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["duty", "--once"], d)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("DUTY t9 delivery-ambiguous: ");
    expect(lines[0]).toContain("hc exploded");
  });

  test("kill switch: a stopped duty loop flushes, nudges and escalates nothing; resume delivers what was held", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "quiet", brief, { group: "w1" });
    w.panes.get(lane.paneId)!.status = "idle";
    lead.status = "working";
    expect(await send(d, "lead", "held note", "cli")).toBe("QUEUED");
    lead.status = "idle";
    lead.received.length = 0;
    w.clock = lane.createdAt + 40 * 60_000;
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["duty", "stop", "--text", "maintenance"], d)).toBe(0);
      expect(await main(["duty", "--once"], d)).toBe(0);
      expect(await main(["duty", "status"], d)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines).toEqual(["DUTY STOPPED", "DUTY stopped: maintenance", "stopped: maintenance"]);
    expect(lead.received).toEqual([]);
    expect(d.store.lane("quiet")!.nudges).toBe(0);
    expect(d.store.stop()).toBeUndefined();
    expect(w.dutyCounts).toEqual([]);

    await main(["duty", "resume"], d);
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "t1", action: "flushed" });
    expect(events).toContainEqual({ lane: "quiet", action: "nudge-1" });
    expect(lead.received).toEqual(["held note"]);
  });

  test("duty refuses an --interval under a millisecond before it runs a tick", async () => {
    const { w, d } = setup();
    for (const bad of ["abc", "0", "-5", "30s", "0.0005", "1e-9"]) {
      await expect(main(["duty", "--once", "--interval", bad], d)).rejects.toThrow(
        "--interval must be a number of seconds, 0.001 or more",
      );
    }
    expect(w.dutyCounts).toEqual([]);
    for (const good of ["0.001", "0.5"]) expect(await main(["duty", "--once", "--interval", good], d)).toBe(0);
    expect(w.dutyCounts).toHaveLength(2);
  });

  test("a working lane counts as activity; a vanished pane is reported LOST", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "busy", brief, { group: "w1" });
    w.panes.get(lane.paneId)!.status = "working";
    w.clock += 30 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("busy")!.lastActivityAt).toBe(w.clock);
    expect(w.touches).toBeGreaterThan(0);
    w.panes.delete(lane.paneId);
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "lost" });
    expect(lead.received.at(-1)).toContain("[LOST busy]");
  });
});
