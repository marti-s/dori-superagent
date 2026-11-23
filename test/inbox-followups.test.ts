import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { captureIo, setup, typedEntry } from "./inbox-setup.ts";
import { sref } from "./fake.ts";

// #108: follow-ups to #89 (PR 102).

describe("a typed entry is held, never Entered (#108 1)", () => {
  test("the agent exits (no agent in the pane): held, the lead is told once, and no Enter when an agent comes back", async () => {
    const s = setup();
    typedEntry(s);
    s.pane.status = "shell";
    expect(await dutyTick(s.d)).toContainEqual(expect.objectContaining({ pane: "t2", action: "delivery-ambiguous" }));
    expect(s.d.store.queued(sref("t2")).map((m) => m.attempt?.state)).toEqual(["ambiguous"]);

    s.pane.status = "idle";
    for (let i = 0; i < 2; i++) {
      expect(await dutyTick(s.d)).toContainEqual(expect.objectContaining({ pane: "t2", action: "delivery-ambiguous" }));
    }
    expect(s.typedInto("t2")).toBe(0);
    expect(s.notices()).toHaveLength(1);
    expect(s.notices()[0]).not.toContain("SECRET");
    expect(s.notices()[0]).toContain("dori inbox resend t2");
  });

  test("an agent still in front: hc cannot tell whose input holds the text, so the entry is held with one notice", async () => {
    const s = setup();
    typedEntry(s);
    expect(await dutyTick(s.d)).toContainEqual(expect.objectContaining({ pane: "t2", action: "delivery-ambiguous" }));
    await dutyTick(s.d);
    expect(s.typedInto("t2")).toBe(0);
    expect(s.d.store.queued(sref("t2")).map((m) => m.attempt?.state)).toEqual(["ambiguous"]);
    expect(s.notices()).toHaveLength(1);
  });
});

describe("releasing held entries: dori inbox list | ack | resend (#108 2)", () => {
  function heldInbox(s: ReturnType<typeof setup>) {
    const long = `SECRET "quoted"\n${"x".repeat(100)}`;
    s.d.store.saveInbox(sref("t2"), [
      { at: 0, from: "lane-a", text: long, attempt: { at: 1, state: "ambiguous", detail: "timeout" } },
      { at: 60_000, from: "cli", text: "typed one", attempt: { at: 60_001, state: "typed" } },
      { at: 120_000, from: "duty", text: "plain" },
    ]);
    return long;
  }

  test("list prints index, state, sender and queued time, and at most the first 60 characters JSON-escaped", async () => {
    const s = setup();
    const long = heldInbox(s);
    const r = await captureIo(() => main(["inbox", "list", "t2"], s.d));
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      `1 held from lane-a queued 1970-01-01T00:00:00.000Z ${JSON.stringify(long.slice(0, 60))}...`,
      `2 typed from cli queued 1970-01-01T00:01:00.000Z "typed one"`,
      `3 queued from duty queued 1970-01-01T00:02:00.000Z "plain"`,
    ]);
    expect(r.out).not.toContain("x".repeat(61));
  });

  test("ack drops the held entry and nothing else; a role name resolves to its pane", async () => {
    const s = setup();
    heldInbox(s);
    s.d.store.setRole("duty", sref("t2"));
    const r = await captureIo(() => main(["inbox", "ack", "duty", "1"], s.d));
    expect(r).toEqual({ code: 0, out: "ACKED t2 1" });
    expect(s.d.store.queued(sref("t2")).map((m) => m.text)).toEqual(["typed one", "plain"]);
  });

  test("ack and resend refuse an entry that is not held, and an index out of range", async () => {
    const s = setup();
    heldInbox(s);
    await expect(main(["inbox", "ack", "t2", "2"], s.d)).rejects.toThrow(/not held/);
    await expect(main(["inbox", "resend", "t2", "3"], s.d)).rejects.toThrow(/not held/);
    await expect(main(["inbox", "ack", "t2", "4"], s.d)).rejects.toThrow(/no entry 4/);
    await expect(main(["inbox", "ack", "t2", "x"], s.d)).rejects.toThrow(/no entry/);
    expect(s.d.store.queued(sref("t2"))).toHaveLength(3);
  });

  test("resend clears the attempt, and the next flush delivers it exactly once", async () => {
    const s = setup();
    s.d.store.saveInbox(sref("t2"), [
      { at: 0, from: "cli", text: "again", attempt: { at: 1, state: "ambiguous", detail: "timeout" } },
    ]);
    expect(await dutyTick(s.d)).toContainEqual(expect.objectContaining({ pane: "t2", action: "delivery-ambiguous" }));
    expect(s.pane.received).toEqual([]);
    const r = await captureIo(() => main(["inbox", "resend", "t2", "1"], s.d));
    expect(r.out).toBe("RELEASED t2 1: the next flush delivers it");
    expect(s.d.store.queued(sref("t2"))).toEqual([{ at: 0, from: "cli", text: "again" }]);
    expect(await dutyTick(s.d)).toEqual([{ pane: "t2", action: "flushed" }]);
    expect(await dutyTick(s.d)).toEqual([]);
    expect(s.pane.received).toEqual(["again"]);
  });

  test("a gone pane with only held entries reports inbox-target-gone, not delivery-ambiguous", async () => {
    const s = setup();
    s.d.store.saveInbox(sref("t2"), [{ at: 0, from: "cli", text: "held", attempt: { at: 1, state: "ambiguous" } }]);
    s.w.panes.delete("t2");
    expect(await dutyTick(s.d)).toEqual([{ pane: "t2", action: "inbox-target-gone" }]);
  });
});
