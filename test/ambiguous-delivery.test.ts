import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { send } from "../src/inbox.ts";
import { World, sref } from "./fake.ts";

// #89: a delivery that failed after the text may already have reached the pane is never re-sent blindly.

function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("t1", "idle");
  d.store.setRole("lead", sref("t1"));
  /** How many `hc send` calls were made for a terminal: each one is an attempt to type the text. */
  const sends = (pane: string) => w.hcCalls("send", pane).length;
  return { w, d, lead, sends };
}

/** Runs the CLI and captures everything it writes: console.log, console.error and raw stderr writes. */
async function captureIo(run: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  const write = process.stderr.write;
  console.log = (...a: unknown[]) => {
    out.push(a.join(" "));
  };
  console.error = (...a: unknown[]) => {
    err.push(a.join(" "));
  };
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), out: out.join("\n"), err: err.join("") };
  } finally {
    console.log = log;
    console.error = error;
    process.stderr.write = write;
  }
}

const HELD_LINE = (target: string) => `HELD ${target}: delivery may or may not have reached the pane; do not resend`;

function addLane(d: ReturnType<World["deps"]>, key: string, paneId: string): void {
  d.store.saveLane({
    key,
    sessionRef: sref(paneId),
    paneId,
    tabId: paneId,
    brief: "/dev/null",
    cwd: "/",
    status: "working",
    createdAt: 0,
    lastActivityAt: 0,
    nudges: 0,
    log: [],
  });
}

describe("a typed entry left in the inbox (#89 A)", () => {
  test("hc never presses a lone Enter: the entry is held, nothing is typed, and the lead is told once", async () => {
    const { w, d, lead, sends } = setup();
    const lane = w.addPane("t2", "idle");
    d.store.saveInbox(sref("t2"), [
      {
        at: w.clock - 1,
        from: "cli",
        text: "SECRET instruction",
        attempt: { at: w.clock - 1, state: "typed", detail: "key press failed" },
      },
    ]);

    const ticks = [await dutyTick(d), await dutyTick(d)];
    for (const events of ticks)
      expect(events).toContainEqual(expect.objectContaining({ pane: "t2", action: "delivery-ambiguous" }));
    expect(sends("t2")).toBe(0);
    expect(w.hcCalls("keys", "t2")).toEqual([]);
    expect(lane.received).toEqual([]);
    expect(d.store.queued(sref("t2")).map((m) => m.attempt?.state)).toEqual(["ambiguous"]);
    const notices = lead.received.filter((m) => m.startsWith("[DELIVERY-AMBIGUOUS t2]"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain("SECRET");
  });
});

describe("ambiguous `hc send` failure (#89 B)", () => {
  test("a send that failed without saying why: the lead is told exactly once across several dutyTicks and the text is not re-sent", async () => {
    const { w, d, lead, sends } = setup();
    const lane = w.addPane("t2", "idle");
    w.sendFails.set("t2", "timeout");
    d.store.enqueue(sref("t2"), { at: w.clock, from: "cli", text: "SECRET instruction" });

    const ticks = [await dutyTick(d), await dutyTick(d), await dutyTick(d)];
    for (const events of ticks) {
      expect(events).toContainEqual(expect.objectContaining({ pane: "t2", action: "delivery-ambiguous" }));
      expect(events.some((e) => e.action === "flush-failed")).toBe(false);
      expect(JSON.stringify(events)).not.toContain("SECRET");
    }
    expect(sends("t2")).toBe(1);
    expect(lane.received).toEqual([]);
    const notices = lead.received.filter((m) => m.includes("t2"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain("SECRET");
    expect(d.store.queued(sref("t2"))).toHaveLength(1);
  });

  test("an ambiguous failure on the lead's own pane is held and not re-sent, with no notice loop", async () => {
    const { w, d, lead, sends } = setup();
    w.sendFails.set("t1", "timeout");
    expect(await send(d, "lead", "hello", "cli")).toBe("HELD");
    for (let i = 0; i < 3; i++) await dutyTick(d);
    w.sendFails.delete("t1");
    expect(await dutyTick(d)).toContainEqual(expect.objectContaining({ pane: "t1", action: "delivery-ambiguous" }));
    // one send for the message, one for the notice about it; neither is retried
    expect(sends("t1")).toBe(2);
    expect(lead.received).toEqual([]);
  });
});

describe("a typed entry with newer messages queued (#89 review)", () => {
  test("send() of the newer message holds the typed one, returns QUEUED, and the next pass delivers only the newer one", async () => {
    const { w, d, lead, sends } = setup();
    d.store.saveInbox(sref("t1"), [
      {
        at: w.clock - 1,
        from: "cli",
        text: "FIRST",
        attempt: { at: w.clock - 1, state: "typed", detail: "key press failed" },
      },
    ]);
    expect(await send(d, "lead", "SECOND", "cli")).toBe("QUEUED");
    expect(w.hcCalls("keys", "t1")).toEqual([]);
    expect(sends("t1")).toBe(0);
    expect(d.store.queued(sref("t1")).map((m) => [m.text.slice(0, 6), m.attempt?.state])).toEqual([
      ["FIRST", "ambiguous"],
      ["SECOND", undefined],
      ["[DELIV", undefined],
    ]);

    expect(await dutyTick(d)).toContainEqual({ pane: "t1", action: "flushed" });
    expect(lead.received).toHaveLength(1);
    expect(lead.received[0]).toContain("SECOND");
    expect(lead.received[0]).not.toContain("FIRST");
    expect(d.store.queued(sref("t1")).map((m) => m.text)).toEqual(["FIRST"]);
  });
});

describe("the CLI on an uncertain first delivery (#89 review)", () => {
  test("dori send, ambiguous send error: prints HELD, exits 3, never shows the text, and holds exactly one entry", async () => {
    const { w, d, sends } = setup();
    w.addPane("t2", "idle");
    w.sendFails.set("t2", "timeout");
    const r = await captureIo(() => main(["send", "t2", "--text", "SECRET instruction"], d));
    expect(r.code).toBe(3);
    expect(r.out).toBe(HELD_LINE("t2"));
    expect(r.out + r.err).not.toContain("SECRET");
    const held = d.store.queued(sref("t2"));
    expect(held).toHaveLength(1);
    expect(held[0]!.attempt?.state).toBe("ambiguous");
    expect(sends("t2")).toBe(1);
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
    const fromLane = d.store.queued(sref("t1")).filter((m) => m.from === "fix-x");
    expect(fromLane).toHaveLength(1);
    expect(fromLane[0]!.attempt?.state).toBe("ambiguous");
    expect(d.store.lane("fix-x")!.log.at(-1)).toMatchObject({ kind: "report", text: "SECRET progress" });
  });

  test("dori ready, ambiguous delivery to the lead: no crash, prints HELD for the lead, exits 3, READY recorded", async () => {
    const { w, d } = setup();
    addLane(d, "fix-x", "t2");
    w.addPane("t2", "idle");
    w.sendFails.set("t1", "timeout");
    const r = await captureIo(() =>
      main(["ready", "fix-x", "--text", "SECRET answer", "--evidence", "https://example.com/pr/1"], d),
    );
    expect(r.code).toBe(3);
    expect(r.out).toBe(`READY fix-x\n${HELD_LINE("lead")}`);
    expect(r.out + r.err).not.toContain("SECRET");
    expect(d.store.queued(sref("t1")).filter((m) => m.from === "fix-x")).toHaveLength(1);
    expect(d.store.lane("fix-x")!.status).toBe("ready");
  });
});

describe("control", () => {
  test("normal delivery is unchanged: delivered once through one hc send, inbox empty", async () => {
    const { d, lead, sends } = setup();
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello"]);
    expect(sends("t1")).toBe(1);
    expect(d.store.queued(sref("t1"))).toEqual([]);
    expect(await dutyTick(d)).toEqual([]);
    expect(sends("t1")).toBe(1);
  });
});
