import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Refusal } from "../src/refusal.ts";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { done, ready, startLane } from "../src/lanes.ts";
import { sref } from "./fake.ts";
import { setup } from "./harness-setup.ts";

describe("lanes", () => {
  test("start opens a tab, launches omo with the brief, and tells the lead", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { group: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    expect(pane.ran[0]).toStartWith("omo 'Read your brief at ");
    expect(await Bun.file(lane.brief).text()).toContain("dori ready fix-login --text");
    expect(lead.received).toEqual([`[START fix-login] lane opened in ${lane.paneId}`]);
    await expect(startLane(d, "fix-login", brief, { group: "w1" })).rejects.toThrow(Refusal);
  });

  test("start refuses the role names lead and duty as lane keys before it writes or opens anything", async () => {
    const { w, d, lead, brief } = setup();
    for (const key of ["lead", "duty"]) {
      await expect(startLane(d, key, brief, { group: "w1" })).rejects.toThrow(
        `lane key "${key}" is reserved for the ${key} role`,
      );
      expect(d.store.lane(key)).toBeUndefined();
      expect(existsSync(d.store.briefPath(key))).toBe(false);
    }
    expect(w.calls).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(d.store.roles().lead).toEqual(sref("t1"));
  });

  test("ready requires evidence, then reaches the lead; done closes only a ready lane", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { group: "w1" });
    await expect(done(d, "fix-login")).rejects.toThrow("not ready");
    await expect(ready(d, "fix-login", "fixed", [])).rejects.toThrow("evidence");
    await ready(d, "fix-login", "fixed", ["https://github.com/o/r/pull/1"]);
    expect(lead.received.at(-1)).toBe("[READY fix-login] fixed\nevidence: https://github.com/o/r/pull/1");
    expect(w.usage.map((e) => e.name)).toEqual(["dori.lane_started", "dori.lane_ready"]);
    expect(JSON.stringify(w.usage)).not.toContain("fix-login");
    await done(d, "fix-login");
    // The terminal is stopped, not removed: its screen stays readable until the duty loop retires it.
    expect(w.panes.get(lane.paneId)?.terminal.state).toBe("finished");
    expect(w.hcCalls("rm")).toEqual([]);
    expect(d.store.lane("fix-login")).toMatchObject({ status: "done", closedAt: w.clock });
  });

  test("a lane whose hc terminal finished without READY is LOST, and its key can be started again", async () => {
    const { w, d, lead, brief } = setup();
    const first = await startLane(d, "wedged", brief);
    const pane = w.panes.get(first.paneId);
    if (pane) pane.finished = true;
    expect(await dutyTick(d)).toContainEqual({ lane: "wedged", action: "lost" });
    expect(d.store.lane("wedged")).toMatchObject({ status: "lost", closedAt: w.clock });
    expect(lead.received.at(-1)).toBe(
      `[LOST wedged] terminal ${first.paneId} finished or closed without a final answer`,
    );
    const again = await startLane(d, "wedged", brief);
    expect(again.paneId).not.toBe(first.paneId);
    expect(d.store.lane("wedged")).toMatchObject({ status: "working", paneId: again.paneId });
    expect(d.store.lane("wedged")?.closedAt).toBeUndefined();
  });

  test("starting a key whose finished lane the duty loop has not seen yet records it LOST first", async () => {
    const { w, d, lead, brief } = setup();
    const first = await startLane(d, "stale", brief);
    await expect(startLane(d, "stale", brief)).rejects.toThrow(`lane stale is already open in ${first.paneId}`);
    const pane = w.panes.get(first.paneId);
    if (pane) pane.finished = true;
    const again = await startLane(d, "stale", brief);
    expect(lead.received.some((m) => m.startsWith("[LOST stale]"))).toBe(true);
    expect(d.store.lane("stale")?.paneId).toBe(again.paneId);
  });

  test("a READY lane is never restarted over, even when its terminal is gone", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "answered", brief);
    await ready(d, "answered", "fixed", ["https://github.com/o/r/pull/1"]);
    w.panes.delete(lane.paneId);
    await expect(startLane(d, "answered", brief)).rejects.toThrow("lane answered is already open");
    expect(d.store.lane("answered")?.status).toBe("ready");
  });

  test("done --abandon closes a lane that never reported READY, with the reason kept; plain done still refuses", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "stuck", brief);
    const pane = w.panes.get(lane.paneId);
    if (pane) pane.status = "working";
    await expect(done(d, "stuck")).rejects.toThrow(
      "not ready: no final answer recorded (close it anyway with --abandon --note WHY)",
    );
    await expect(done(d, "stuck", { note: " " })).rejects.toThrow("--abandon needs a --note");
    await done(d, "stuck", { note: "wedged since the morning" });
    expect(pane?.terminal.state).toBe("finished");
    const closed = d.store.lane("stuck");
    expect(closed?.status).toBe("done");
    expect(closed?.log.at(-1)?.text).toBe("abandoned without READY: wedged since the morning");
    await expect(done(d, "stuck", { note: "again" })).rejects.toThrow("already done");
  });

  test("dori done --abandon --note abandons a finished lane from the CLI, and a lost one too", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "cli-stuck", brief);
    const pane = w.panes.get(lane.paneId);
    if (pane) pane.finished = true;
    expect(await main(["done", "cli-stuck", "--abandon", "--note", "terminal exited"], d)).toBe(0);
    expect(d.store.lane("cli-stuck")?.log.at(-1)?.text).toBe("abandoned without READY: terminal exited");
    expect(w.hcCalls("kill")).toEqual([]);
    const lost = await startLane(d, "cli-lost", brief);
    w.panes.delete(lost.paneId);
    await dutyTick(d);
    expect(d.store.lane("cli-lost")?.status).toBe("lost");
    expect(await main(["done", "cli-lost", "--abandon", "--note", "gave up"], d)).toBe(0);
    expect(d.store.lane("cli-lost")?.status).toBe("done");
    await expect(main(["done", "cli-lost", "--abandon"], d)).rejects.toThrow("--abandon needs a --note");
  });
});

describe("startLane group", () => {
  test("a lane gets this home's group label unless the caller names one", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "own-group", brief);
    await startLane(d, "named-group", brief, { group: "team-a" });
    const groups = w.hcCalls("run").map((argv) => argv.find((a) => a.startsWith("dori.group=")));
    expect(groups[0]).toMatch(/^dori\.group=[0-9a-f]{8}$/);
    expect(groups[1]).toBe("dori.group=team-a");
  });
});
