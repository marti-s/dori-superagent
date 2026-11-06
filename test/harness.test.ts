import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { done, dutyTick, mergeGate, ready, Refusal, report, review, reviewTimeoutMinutes, send, startLane, tabCloseMinutes } from "../src/harness.ts";
import { World } from "./fake.ts";

function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("t1", "idle");
  d.store.setRole("lead", "t1");
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  return { w, d, lead, brief };
}

describe("lanes", () => {
  test("start opens a tab, launches omo with the brief, and tells the lead", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { workspace: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    expect(pane.ran[0]).toStartWith("omo 'Read your brief at ");
    expect(await Bun.file(lane.brief).text()).toContain("dori ready fix-login --text");
    expect(lead.received).toEqual([`[START fix-login] lane opened in ${lane.paneId}`]);
    await expect(startLane(d, "fix-login", brief, { workspace: "w1" })).rejects.toThrow(Refusal);
  });

  test("start refuses the role names lead and duty as lane keys before it writes or opens anything", async () => {
    const { w, d, lead, brief } = setup();
    for (const key of ["lead", "duty"]) {
      await expect(startLane(d, key, brief, { workspace: "w1" })).rejects.toThrow(`lane key "${key}" is reserved for the ${key} role`);
      expect(d.store.lane(key)).toBeUndefined();
      expect(existsSync(d.store.briefPath(key))).toBe(false);
    }
    expect(w.calls).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(d.store.roles().lead).toBe("t1");
  });

  test("ready requires evidence, then reaches the lead; done closes only a ready lane", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { workspace: "w1" });
    await expect(done(d, "fix-login")).rejects.toThrow("not ready");
    await expect(ready(d, "fix-login", "fixed", [])).rejects.toThrow("evidence");
    await ready(d, "fix-login", "fixed", ["https://github.com/o/r/pull/1"]);
    expect(lead.received.at(-1)).toBe("[READY fix-login] fixed\nevidence: https://github.com/o/r/pull/1");
    expect(w.usage.map((e) => e.name)).toEqual(["dori.lane_started", "dori.lane_ready"]);
    expect(JSON.stringify(w.usage)).not.toContain("fix-login");
    await done(d, "fix-login");
    expect(w.panes.get(lane.paneId)!.finished).toBe(true);
    expect(d.store.lane("fix-login")!.status).toBe("done");
  });
});

describe("pane messaging", () => {
  test("a busy lead is never interrupted: messages queue and arrive as one batch when it goes idle", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "a-lane", brief, { workspace: "w1" });
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

  test("delivery to a pane that is a plain shell types nothing and reports not delivered", async () => {
    const { w, d } = setup();
    const shell = w.addPane("t7", "shell");
    await expect(d.herdr.deliver("t7", "rm -rf nothing")).resolves.toBe(false);
    expect(shell.received).toEqual([]);
    expect(w.calls.filter((c) => c.argv[0] === "send" || c.argv[0] === "keys")).toEqual([]);
  });

  test("unknown targets are refused instead of guessed", async () => {
    const { d } = setup();
    await expect(send(d, "nobody", "hi", "cli")).rejects.toThrow("unknown target");
  });
});

describe("duty loop", () => {
  test("nudges an idle lane at 10 and 20 minutes, escalates at 40, and ignores WAITING lanes", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "quiet", brief, { workspace: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "idle";
    const at = async (min: number) => { w.clock = lane.createdAt + min * 60_000; return dutyTick(d); };
    expect(await at(5)).toEqual([]);
    expect(await at(10)).toContainEqual({ lane: "quiet", action: "nudge-1" });
    expect(pane.received.at(-1)).toContain("idle for 10 minutes");
    expect(await at(15)).toEqual([]);
    expect(await at(20)).toContainEqual({ lane: "quiet", action: "nudge-2" });
    expect(await at(40)).toContainEqual({ lane: "quiet", action: "escalated" });
    expect(lead.received.at(-1)).toContain("[ESCALATE quiet]");
    expect(await at(90)).toEqual([]);

    const waiting = await startLane(d, "blocked-on-ci", brief, { workspace: "w1" });
    w.panes.get(waiting.paneId)!.status = "idle";
    await report(d, "blocked-on-ci", "WAITING: CI", "waiting");
    w.clock += 60 * 60_000;
    expect((await dutyTick(d)).filter((e) => e.lane === "blocked-on-ci")).toEqual([]);
  });

  test("a failing inbox flush on one pane does not stop the loop for the other panes", async () => {
    const { w, d, lead } = setup();
    const broken = w.addPane("t9", "idle");
    w.sendFails.set("t9", "hc exploded");
    d.store.enqueue("t9", { at: w.clock, from: "cli", text: "to broken" });
    d.store.enqueue("t1", { at: w.clock, from: "cli", text: "to lead" });
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "t9", action: "delivery-ambiguous", detail: expect.stringContaining("hc exploded") });
    expect(events).toContainEqual({ pane: "t1", action: "flushed" });
    expect(lead.received).toHaveLength(1);
    expect(lead.received[0]).toContain("to lead");
    expect(broken.received).toEqual([]);
  });

  test("a failing lane-phase delivery is recorded as lane-failed and does not stop the other lanes", async () => {
    const { w, d, brief } = setup();
    const lost = await startLane(d, "lost-lane", brief, { workspace: "w1" });
    const stuck = await startLane(d, "stuck-lane", brief, { workspace: "w1" });
    const fine = await startLane(d, "fine-lane", brief, { workspace: "w1" });
    w.panes.delete(lost.paneId);
    w.panes.get(stuck.paneId)!.status = "idle";
    w.panes.get(fine.paneId)!.status = "idle";
    w.sendFails.set("t1", "lead exploded");
    w.sendFails.set(stuck.paneId, "stuck exploded");
    w.clock = fine.createdAt + 10 * 60_000;
    const events = await dutyTick(d);
    expect(events).toContainEqual({ lane: "lost-lane", action: "lane-failed", detail: expect.stringContaining("lead exploded") });
    expect(events).toContainEqual({ lane: "stuck-lane", action: "lane-failed", detail: expect.stringContaining("stuck exploded") });
    expect(events).toContainEqual({ lane: "fine-lane", action: "nudge-1" });
    expect(w.panes.get(fine.paneId)!.received.at(-1)).toContain("idle for 10 minutes");
  });

  test("the delivery-ambiguous detail is hc's first output line, never the queued message", async () => {
    const { w, d } = setup();
    w.addPane("t9", "idle");
    w.sendFails.set("t9", "hc exploded\nsecond line");
    d.store.enqueue("t9", { at: w.clock, from: "cli", text: "SECRET queued message" });
    const events = await dutyTick(d);
    expect(events).toEqual([{ pane: "t9", action: "delivery-ambiguous", detail: "hc exploded" }]);
  });

  test("the duty loop prints a delivery-ambiguous line with the reason", async () => {
    const { w, d } = setup();
    w.addPane("t9", "idle");
    w.sendFails.set("t9", "hc exploded");
    d.store.enqueue("t9", { at: w.clock, from: "cli", text: "to broken" });
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
    const lane = await startLane(d, "quiet", brief, { workspace: "w1" });
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

  test("a working lane counts as activity; a vanished pane is reported LOST", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "busy", brief, { workspace: "w1" });
    w.panes.get(lane.paneId)!.status = "working";
    w.clock += 30 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("busy")!.lastActivityAt).toBe(w.clock);
    expect(w.touches).toBeGreaterThan(0);
    w.panes.delete(lane.paneId);
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "lost" });
    expect(lead.received.at(-1)).toContain("[LOST busy]");
  });

  test("a lane whose hc terminal finished without READY is LOST, and its key can be started again", async () => {
    const { w, d, lead, brief } = setup();
    const first = await startLane(d, "wedged", brief, { workspace: "w1" });
    w.panes.get(first.paneId)!.finished = true;
    expect(await dutyTick(d)).toContainEqual({ lane: "wedged", action: "lost" });
    expect(d.store.lane("wedged")!.status).toBe("lost");
    expect(lead.received.at(-1)).toContain("[LOST wedged]");
    const again = await startLane(d, "wedged", brief, { workspace: "w1" });
    expect(again.paneId).not.toBe(first.paneId);
    expect(d.store.lane("wedged")!.status).toBe("working");
  });

  test("starting a key whose finished lane the duty loop has not seen yet records it LOST first", async () => {
    const { w, d, lead, brief } = setup();
    const first = await startLane(d, "stale", brief, { workspace: "w1" });
    await expect(startLane(d, "stale", brief, { workspace: "w1" })).rejects.toThrow(`lane stale is already open in ${first.paneId}`);
    w.panes.get(first.paneId)!.finished = true;
    const again = await startLane(d, "stale", brief, { workspace: "w1" });
    expect(lead.received.some((m) => m.includes("[LOST stale]"))).toBe(true);
    expect(d.store.lane("stale")!.paneId).toBe(again.paneId);
  });

  test("done --abandon closes a lane that never reported READY, with the reason kept; plain done still refuses", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "stuck", brief, { workspace: "w1" });
    w.panes.get(lane.paneId)!.status = "working";
    await expect(done(d, "stuck")).rejects.toThrow("not ready: no final answer recorded (close it anyway with --abandon --note WHY)");
    await expect(done(d, "stuck", { note: " " })).rejects.toThrow("--abandon needs a --note");
    await done(d, "stuck", { note: "wedged since the morning" });
    expect(w.panes.get(lane.paneId)!.finished).toBe(true);
    const closed = d.store.lane("stuck")!;
    expect(closed.status).toBe("done");
    expect(closed.log.at(-1)!.text).toBe("abandoned without READY: wedged since the morning");
    await expect(done(d, "stuck", { note: "again" })).rejects.toThrow("already done");
  });

  test("dori done --abandon --note abandons a finished lane from the CLI", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "cli-stuck", brief, { workspace: "w1" });
    w.panes.get(lane.paneId)!.finished = true;
    expect(await main(["done", "cli-stuck", "--abandon", "--note", "terminal exited"], d)).toBe(0);
    expect(d.store.lane("cli-stuck")!.log.at(-1)!.text).toBe("abandoned without READY: terminal exited");
    expect(w.panes.has(lane.paneId)).toBe(true);
  });
});

describe("retiring finished lanes", () => {
  const MIN = 60_000;

  test("a done lane's terminal and tab are closed 15 minutes later, not before, and the close is logged", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "shipped", brief, { workspace: "w1" });
    await ready(d, "shipped", "fixed", ["https://github.com/o/r/pull/1"]);
    await done(d, "shipped");
    w.clock += 14 * MIN;
    expect((await dutyTick(d)).filter((e) => e.action === "retired")).toEqual([]);
    expect(w.panes.has(lane.paneId)).toBe(true);
    w.clock += MIN;
    const events = await dutyTick(d);
    expect(events).toContainEqual({ lane: "shipped", action: "retired", detail: `terminal ${lane.paneId} removed; tab tab-${lane.paneId} closed` });
    expect(w.panes.has(lane.paneId)).toBe(false);
    expect(w.closedTabs.has(`tab-${lane.paneId}`)).toBe(true);
    expect(d.store.lane("shipped")!.log.at(-1)).toMatchObject({ kind: "retired", text: `terminal ${lane.paneId} removed; tab tab-${lane.paneId} closed` });
    w.clock += 15 * MIN;
    expect((await dutyTick(d)).filter((e) => e.action === "retired")).toEqual([]);
  });

  test("an idle, waiting or READY-but-not-closed lane is never retired, however long it sits", async () => {
    const { w, d, brief } = setup();
    const idle = await startLane(d, "idle-lane", brief, { workspace: "w1" });
    const waiting = await startLane(d, "waiting-lane", brief, { workspace: "w1" });
    await report(d, "waiting-lane", "asked the lead a question", "waiting");
    const readyLane = await startLane(d, "ready-lane", brief, { workspace: "w1" });
    await ready(d, "ready-lane", "fixed", ["https://github.com/o/r/pull/2"]);
    w.panes.get(waiting.paneId)!.status = "blocked";
    w.clock += 24 * 60 * MIN;
    expect((await dutyTick(d)).filter((e) => e.action === "retired")).toEqual([]);
    for (const lane of [idle, waiting, readyLane]) {
      expect(w.panes.get(lane.paneId)!.finished).toBeUndefined();
      expect(w.closedTabs.has(`tab-${lane.paneId}`)).toBe(false);
    }
    expect(d.store.lanes().map((l) => l.closedAt)).toEqual([undefined, undefined, undefined]);
  });

  test("a lane LOST to a finished terminal is retired after the delay too", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "crashed", brief, { workspace: "w1" });
    w.panes.get(lane.paneId)!.finished = true;
    expect(await dutyTick(d)).toContainEqual({ lane: "crashed", action: "lost" });
    w.clock += 15 * MIN;
    expect((await dutyTick(d)).some((e) => e.lane === "crashed" && e.action === "retired")).toBe(true);
    expect(w.panes.has(lane.paneId)).toBe(false);
  });

  test("a lane restarted under its key before the delay is not retired, and its new terminal stays", async () => {
    const { w, d, brief } = setup();
    const first = await startLane(d, "again", brief, { workspace: "w1" });
    await done(d, "again", { note: "restarting" });
    w.clock += 5 * MIN;
    const second = await startLane(d, "again", brief, { workspace: "w1" });
    w.clock += 20 * MIN;
    expect((await dutyTick(d)).filter((e) => e.action === "retired")).toEqual([]);
    expect(w.panes.get(second.paneId)!.finished).toBeUndefined();
    expect(w.closedTabs.has(`tab-${second.paneId}`)).toBe(false);
    expect(w.panes.has(first.paneId)).toBe(true);
  });

  test("the lead's, duty's and the loops' terminals and tabs are never touched", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "near-lead", brief, { workspace: "w1" });
    // A lane whose recorded terminal is the lead's (a bad registration), and one sharing the duty tab with loops.
    const duty = w.addPane("duty-t", "idle");
    d.store.setRole("duty", "duty-t");
    const loopPane = w.addPane("loop-t", "working");
    d.store.setLoops(["loop-t"]);
    duty.appTab = "tab-duty";
    loopPane.appTab = "tab-duty";
    w.panes.get(lane.paneId)!.appTab = "tab-duty";
    await done(d, "near-lead", { note: "gone" });
    const leadLane = await startLane(d, "is-lead", brief, { workspace: "w1" });
    d.store.saveLane({ ...d.store.lane("is-lead")!, paneId: "t1", status: "done", closedAt: w.clock });
    w.clock += 15 * MIN;
    const events = await dutyTick(d);
    expect(events).toContainEqual({ lane: "near-lead", action: "retired", detail: `terminal ${lane.paneId} removed; tab tab-duty kept: it holds live duty-t, loop-t` });
    expect(events).toContainEqual({ lane: "is-lead", action: "retired", detail: "kept: terminal t1 is the lead's, duty's or a loop's" });
    expect(w.closedTabs.size).toBe(0);
    expect(w.panes.has("t1")).toBe(true);
    expect(w.panes.get("t1")!.finished).toBeUndefined();
    expect([duty.finished, loopPane.finished]).toEqual([undefined, undefined]);
    expect(w.panes.has(leadLane.paneId)).toBe(true);
  });

  test("a terminal at the lane's address that dori did not start for that lane is kept", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "reused", brief, { workspace: "w1" });
    await done(d, "reused", { note: "done" });
    w.panes.set(lane.paneId, { status: "idle", received: [], ran: [], name: "someone-else", argv: ["zsh"] });
    w.clock += 15 * MIN;
    expect(await dutyTick(d)).toContainEqual({ lane: "reused", action: "retired", detail: `kept: terminal ${lane.paneId} is not the one dori started for lane reused` });
    expect(w.panes.has(lane.paneId)).toBe(true);
    expect(w.closedTabs.size).toBe(0);
  });

  test("DORI_TAB_CLOSE_MIN of 0 never retires; unset is 15 minutes and a bad value is refused", async () => {
    expect(tabCloseMinutes(undefined)).toBe(15);
    expect(tabCloseMinutes("0")).toBe(0);
    expect(() => tabCloseMinutes("-1")).toThrow("0 or a positive number");
    const { w, d, brief } = setup();
    const off = { ...d, tabCloseDelayMs: 0 };
    const lane = await startLane(off, "kept", brief, { workspace: "w1" });
    await done(off, "kept", { note: "x" });
    w.clock += 24 * 60 * MIN;
    expect((await dutyTick(off)).filter((e) => e.action === "retired")).toEqual([]);
    expect(w.panes.has(lane.paneId)).toBe(true);
  });
});

describe("review + merge gate", () => {
  const head = "a".repeat(40);
  function gh(w: World, checks: unknown[]) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify(checks) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  test("merge is refused without a receipt, with an empty check list, with red checks; allowed at CLEAR + green", async () => {
    const { w, d } = setup();
    gh(w, []);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 ...\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#7")).verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("is BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#7", "some/model");
    expect(d.store.receipt("o/r#7", head)!.model).toBe("some/model");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    gh(w, [{ name: "test", bucket: "fail" }, { name: "lint", bucket: "pass" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("every check was skipped");
    gh(w, [{ name: "test", bucket: "pass" }, { name: "docs", bucket: "skipping" }]);
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
    expect(w.calls.at(-1)!.argv).toContain("--match-head-commit");
    expect(w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome))
      .toEqual(["no_receipt", "review_block", "no_checks", "checks_red", "checks_all_skipped", "merged"]);
    expect(w.usage.filter((e) => e.name === "dori.review_completed")).toHaveLength(2);
  });

  test("a review longer than 4000 characters keeps its start: the full text is saved beside the receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    const findings = Array.from({ length: 200 }, (_, i) => `MEDIUM src/f${i}.ts:${i} a finding long enough to fill the review`).join("\n");
    const stdout = `SUMMARY: two blocking bugs\nHIGH src/a.ts:1 the most severe finding\n${findings}\nVERDICT: BLOCK`;
    expect(stdout.length).toBeGreaterThan(4000);
    w.reviewer = () => ({ code: 0, stdout });
    const r = await review(d, "o/r#9");
    const receipt = d.store.receipt("o/r#9", head)!;
    expect(receipt.review).toBe(r.review);
    expect(r.review.endsWith(`o__r_9@${head}.md`)).toBe(true);
    expect(await Bun.file(r.review).text()).toBe(`${stdout}\n`);
    expect(receipt.summary.length).toBeLessThanOrEqual(4000);
    expect(receipt.summary.startsWith("SUMMARY: two blocking bugs\nHIGH src/a.ts:1 the most severe finding")).toBe(true);
    expect(receipt.summary.endsWith("VERDICT: BLOCK")).toBe(true);
  });

  test("a reviewer without a VERDICT line is tried once more, then fails with no receipt and its output kept", async () => {
    const { w, d } = setup();
    gh(w, []);
    let runs = 0;
    w.reviewer = () => ({ code: 0, stdout: `looks fine I guess (run ${++runs})` });
    const error = await review(d, "o/r#8").catch((e: unknown) => e);
    expect(String(error)).toContain("no VERDICT line twice; no receipt written");
    expect(runs).toBe(2);
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
    const kept = String(error).split("its output: ")[1]!;
    expect(kept.endsWith(`o__r_8@${head}.md`)).toBe(true);
    expect(await Bun.file(kept).text()).toBe("looks fine I guess (run 2)\n");
  });

  test("a reviewer that prints its VERDICT on the retry gets a receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    const outputs = ["the session ended early", "no findings\nVERDICT: CLEAR"];
    w.reviewer = () => ({ code: 0, stdout: outputs.shift()! });
    expect((await review(d, "o/r#10")).verdict).toBe("CLEAR");
    expect(outputs).toEqual([]);
    expect(await Bun.file(d.store.receipt("o/r#10", head)!.review).text()).toBe("no findings\nVERDICT: CLEAR\n");
  });

  test("a reviewer that hits its timeout fails the review with no receipt and no retry", async () => {
    const { w, d } = setup();
    gh(w, []);
    const timeouts: (number | undefined)[] = [];
    w.reviewer = (_argv, opts) => {
      timeouts.push(opts?.timeoutMs);
      return { code: 137, stdout: "HIGH src/a.ts:1 half a review", timedOut: true };
    };
    const error = await review(d, "o/r#11").catch((e: unknown) => e);
    expect(String(error)).toContain("reviewer timed out after 25 min; no receipt written");
    expect(timeouts).toEqual([25 * 60_000]);
    expect(d.store.receipt("o/r#11", head)).toBeUndefined();
    expect(await Bun.file(String(error).split("its output so far: ")[1]!).text()).toBe("HIGH src/a.ts:1 half a review\n");
  });

  test("DORI_REVIEW_TIMEOUT_MIN sets the reviewer timeout; unset is 25 minutes and a bad value is refused", () => {
    expect(reviewTimeoutMinutes(undefined)).toBe(25);
    expect(reviewTimeoutMinutes("40")).toBe(40);
    expect(() => reviewTimeoutMinutes("0")).toThrow("positive number of minutes");
    expect(() => reviewTimeoutMinutes("soon")).toThrow("positive number of minutes");
  });
});
