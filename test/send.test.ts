import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { send } from "../src/inbox.ts";
import { report, startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";
import { sref } from "./fake.ts";

const lead1 = sref("t1");

describe("pane messaging", () => {
  test("a busy lead is never interrupted: messages queue and arrive as one batch when it goes idle", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "a-lane", brief, { group: "w1" });
    lead.received.length = 0;
    lead.status = "working";
    await report(d, "a-lane", "tests red, investigating");
    expect(await send(d, "lead", "second note", "a-lane")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    lead.status = "idle";
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "t1", action: "flushed" });
    expect(lead.received).toHaveLength(1);
    expect(lead.received[0]).toContain("2 messages arrived while you were busy");
    expect(lead.received[0]).toContain("[REPORT a-lane] tests red, investigating");
    expect(lead.received[0]).toContain("second note");
  });

  test("an `hc send` failure that names no reason is ambiguous, whatever the message itself mentions", async () => {
    const { w, d, lead } = setup();
    w.sendFails.set("t1", "hc exploded");
    const out = await d.runtimes.for(lead1).deliver(lead1, "a lane quoted status_mismatch here");
    expect(out.kind === "ambiguous" && out.detail).toContain("hc exploded");
    expect(lead.received).toEqual([]);
  });

  test("a pane that is a plain shell gets nothing typed and reports not delivered", async () => {
    const { w, d } = setup();
    const shell = w.addPane("t7", "shell");
    expect(await d.runtimes.for(sref("t7")).deliver(sref("t7"), "rm -rf nothing")).toEqual({ kind: "no-agent" });
    expect(shell.received).toEqual([]);
  });

  test("an empty or blank --text is refused by send, report and ready; nothing is queued or typed", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "a-lane", brief, { group: "w1" });
    lead.received.length = 0;
    for (const argv of [
      ["send", "lead", "--text", ""],
      ["send", "lead", "--text", "  \n "],
      ["report", "a-lane", "--text", ""],
      ["ready", "a-lane", "--text", " ", "--evidence", "https://example.com/pr/1"],
    ]) {
      await expect(main(argv, d)).rejects.toThrow("the message is empty");
    }
    expect(lead.received).toEqual([]);
    expect(d.store.queued(lead1)).toEqual([]);
  });

  test("unknown targets are refused instead of guessed", async () => {
    const { d } = setup();
    await expect(send(d, "nobody", "hi", "cli")).rejects.toThrow("unknown target");
  });
});
