import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { dutyTick, send } from "../src/harness.ts";
import { World } from "./fake.ts";

// #89: a delivery that failed after the text may already have reached the pane is never re-sent blindly.

function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("t1", "idle");
  d.store.setRole("lead", "t1");
  const count = (pane: string, verb: "send" | "keys") =>
    w.calls.filter((c) => c.cmd === "hc" && c.argv[0] === verb && c.argv[1] === pane).length;
  return { w, d, lead, count };
}

/** Runs the CLI and captures everything it writes: console.log, console.error and raw stderr writes. */
async function captureIo(run: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  const write = process.stderr.write;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.join(" ")); };
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    return { code: await run(), out: out.join("\n"), err: err.join("") };
  } finally {
    console.log = log;
    console.error = error;
    process.stderr.write = write;
  }
}

const HELD_LINE = (target: string) => `HELD ${target}: delivery may or may not have reached the pane; do not resend`;

/** A message an earlier pass typed into the pane whose submitting Enter failed. */
function typedEarlier(d: ReturnType<World["deps"]>, w: World, paneId: string, text: string): void {
  d.store.saveInbox(paneId, [{ at: w.clock - 1, from: "cli", text, attempt: { at: w.clock - 1, state: "typed", detail: "key press failed" } }]);
}

function addLane(d: ReturnType<World["deps"]>, key: string, paneId: string): void {
  d.store.saveLane({
    key, paneId, tabId: "w1:t9", brief: "/dev/null", cwd: "/", status: "working",
    createdAt: 0, lastActivityAt: 0, nudges: 0, log: [],
  });
}

describe("typed text whose Enter failed (#89 A)", () => {
  test("Enter fails: the next dutyTick presses only Enter and never types the text again", async () => {
    const { w, d, count } = setup();
    typedEarlier(d, w, "t1", "IMPORTANT MESSAGE");
    w.keyFails = 1;
    expect(await dutyTick(d)).toEqual([{ pane: "t1", action: "flush-failed", detail: "key press failed" }]);
    expect(count("t1", "keys")).toBe(1);
    expect(d.store.queued("t1").map((m) => m.attempt?.state)).toEqual(["typed"]);

    expect(await dutyTick(d)).toEqual([{ pane: "t1", action: "flushed" }]);
    expect(count("t1", "keys")).toBe(2);
    expect(w.calls.at(-1)!.argv).toEqual(["keys", "t1", "enter"]);
    expect(d.store.queued("t1")).toEqual([]);

    expect(await dutyTick(d)).toEqual([]);
    expect(count("t1", "keys")).toBe(2);
    expect(count("t1", "send")).toBe(0);
  });

  test("the pending Enter is held while a shell is in front, and pressed once the agent is back", async () => {
    const { w, d, lead, count } = setup();
    typedEarlier(d, w, "t1", "IMPORTANT MESSAGE");

    lead.status = "shell";
    expect(await dutyTick(d)).toContainEqual(expect.objectContaining({ pane: "t1", action: "inbox-held" }));
    lead.status = "idle";
    lead.foreground = "-zsh";
    expect(await dutyTick(d)).toContainEqual(expect.objectContaining({ pane: "t1", action: "inbox-held" }));
    expect(count("t1", "keys")).toBe(0);

    lead.foreground = undefined;
    expect(await dutyTick(d)).toEqual([{ pane: "t1", action: "flushed" }]);
    expect(count("t1", "keys")).toBe(1);
    expect(count("t1", "send")).toBe(0);
  });
});

describe("ambiguous `hc send` failure (#89 B)", () => {
  test("a failed send: the lead is told exactly once across several dutyTicks and the prompt is not re-sent", async () => {
    const { w, d, lead, count } = setup();
    const lane = w.addPane("t2", "idle");
    w.sendFails.set("t2", "timeout");
    d.store.enqueue("t2", { at: w.clock, from: "cli", text: "SECRET instruction" });

    const ticks = [await dutyTick(d), await dutyTick(d), await dutyTick(d)];
    for (const events of ticks) {
      expect(events).toContainEqual(expect.objectContaining({ pane: "t2", action: "delivery-ambiguous" }));
      expect(events.some((e) => e.action === "flush-failed")).toBe(false);
      expect(JSON.stringify(events)).not.toContain("SECRET");
    }
    expect(count("t2", "send")).toBe(1);
    expect(count("t2", "keys")).toBe(0);
    expect(lane.received).toEqual([]);
    const notices = lead.received.filter((m) => m.includes("t2"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain("SECRET");
    expect(d.store.queued("t2")).toHaveLength(1);
  });

  test("an ambiguous failure on the lead's own pane is held and not re-sent, with no notice loop", async () => {
    const { w, d, lead, count } = setup();
    w.sendFails.set("t1", "timeout");
    expect(await send(d, "lead", "hello", "cli")).toBe("HELD");
    for (let i = 0; i < 3; i++) await dutyTick(d);
    w.sendFails.delete("t1");
    expect(await dutyTick(d)).toContainEqual(expect.objectContaining({ pane: "t1", action: "delivery-ambiguous" }));
    // one send for the message, one for the notice about it; neither is retried
    expect(count("t1", "send")).toBe(2);
    expect(lead.received).toEqual([]);
  });
});

describe("a pending Enter with newer messages queued (#89 review)", () => {
  test("send() of the newer message presses only the pending Enter, returns QUEUED, and keeps the newer message queued", async () => {
    const { w, d, lead, count } = setup();
    typedEarlier(d, w, "t1", "FIRST");
    expect(await send(d, "lead", "SECOND", "cli")).toBe("QUEUED");
    expect(count("t1", "keys")).toBe(1);
    expect(count("t1", "send")).toBe(0);
    expect(d.store.queued("t1").map((m) => m.text)).toEqual(["SECOND"]);

    expect(await dutyTick(d)).toEqual([{ pane: "t1", action: "flushed" }]);
    expect(lead.received).toEqual(["SECOND"]);
    expect(d.store.queued("t1")).toEqual([]);
  });
});

describe("the CLI on an uncertain first delivery (#89 review)", () => {
  test("dori send, ambiguous send error: prints HELD, exits 3, never shows the text, and holds exactly one entry", async () => {
    const { w, d, count } = setup();
    w.addPane("t2", "idle");
    w.sendFails.set("t2", "timeout");
    const r = await captureIo(() => main(["send", "t2", "--text", "SECRET instruction"], d));
    expect(r.code).toBe(3);
    expect(r.out).toBe(HELD_LINE("t2"));
    expect(r.out + r.err).not.toContain("SECRET");
    const held = d.store.queued("t2");
    expect(held).toHaveLength(1);
    expect(held[0]!.attempt?.state).toBe("ambiguous");
    expect(count("t2", "send")).toBe(1);
  });

  test("dori send while typed text waits for an Enter that fails again: prints QUEUED and exits 0, the typed entry kept", async () => {
    const { w, d } = setup();
    w.addPane("t2", "idle");
    typedEarlier(d, w, "t2", "EARLIER");
    w.keyFails = 1;
    const r = await captureIo(() => main(["send", "t2", "--text", "SECRET instruction"], d));
    expect(r.code).toBe(0);
    expect(r.out).toBe("QUEUED t2");
    expect(r.out + r.err).not.toContain("SECRET");
    expect(d.store.queued("t2").map((m) => [m.text, m.attempt?.state])).toEqual([["EARLIER", "typed"], ["SECRET instruction", undefined]]);
  });

  test("dori report, ambiguous delivery to the lead: no crash, prints HELD for the lead, exits 3, report held once", async () => {
    const { w, d } = setup();
    addLane(d, "fix-x", "t2");
    w.addPane("t2", "working");
    w.sendFails.set("t1", "timeout");
    const r = await captureIo(() => main(["report", "fix-x", "--text", "SECRET progress"], d));
    expect(r.code).toBe(3);
    expect(r.out).toBe(`REPORTED fix-x\n${HELD_LINE("lead")}`);
    expect(r.out + r.err).not.toContain("SECRET");
    const fromLane = d.store.queued("t1").filter((m) => m.from === "fix-x");
    expect(fromLane).toHaveLength(1);
    expect(fromLane[0]!.attempt?.state).toBe("ambiguous");
    expect(d.store.lane("fix-x")!.log.at(-1)).toMatchObject({ kind: "report", text: "SECRET progress" });
  });

  test("dori ready, ambiguous delivery to the lead: no crash, prints HELD for the lead, exits 3, READY recorded", async () => {
    const { w, d } = setup();
    addLane(d, "fix-x", "t2");
    w.addPane("t2", "idle");
    w.sendFails.set("t1", "timeout");
    const r = await captureIo(() => main(["ready", "fix-x", "--text", "SECRET answer", "--evidence", "https://example.com/pr/1"], d));
    expect(r.code).toBe(3);
    expect(r.out).toBe(`READY fix-x\n${HELD_LINE("lead")}`);
    expect(r.out + r.err).not.toContain("SECRET");
    expect(d.store.queued("t1").filter((m) => m.from === "fix-x")).toHaveLength(1);
    expect(d.store.lane("fix-x")!.status).toBe("ready");
  });
});

describe("control", () => {
  test("normal delivery: delivered once through one hc send, no extra keys, inbox empty", async () => {
    const { w, d, lead, count } = setup();
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello"]);
    expect(count("t1", "send")).toBe(1);
    expect(count("t1", "keys")).toBe(0);
    expect(d.store.queued("t1")).toEqual([]);
    expect(await dutyTick(d)).toEqual([]);
    expect(count("t1", "send")).toBe(1);
  });
});
