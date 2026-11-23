import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Refusal } from "../src/refusal.ts";
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
    expect(w.panes.has(lane.paneId)).toBe(false);
    expect(d.store.lane("fix-login")!.status).toBe("done");
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
