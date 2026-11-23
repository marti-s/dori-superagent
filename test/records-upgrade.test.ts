import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { status } from "../src/cli-up.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

// A lanes/<key>.json and a roles.json exactly as a binary from before session refs existed wrote them.
const OLD_LANE = {
  key: "old-lane",
  paneId: "t3",
  tabId: "t3",
  brief: "/b.md",
  cwd: "/w",
  status: "working",
  createdAt: 1,
  lastActivityAt: 1,
  nudges: 0,
  log: [],
};

function oldHome() {
  const w = new World();
  const d = w.deps();
  const laneFile = join(d.store.root, "lanes", "old-lane.json");
  writeFileSync(laneFile, JSON.stringify(OLD_LANE));
  writeFileSync(
    join(d.store.root, "lanes", "no-tab.json"),
    JSON.stringify({ ...OLD_LANE, key: "no-tab", tabId: "", createdAt: 2 }),
  );
  writeFileSync(join(d.store.root, "roles.json"), JSON.stringify({ lead: "t1", duty: "t2" }));
  return { w, d, laneFile };
}

describe("records written before session refs existed (IS-3)", () => {
  test("lane() and lanes() read an old lane as the hc terminal its paneId names; bare roles are hc refs", () => {
    const { d } = oldHome();
    const want: SessionRef = { runtime: "hc", id: "t3" };
    expect(d.store.lane("old-lane")?.sessionRef).toEqual(want);
    expect(d.store.lanes().map((l) => l.sessionRef)).toEqual([want, want]);
    expect(d.store.roles()).toEqual({
      lead: { runtime: "hc", id: "t1" },
      duty: { runtime: "hc", id: "t2" },
    });
    expect(d.store.laneBySession({ runtime: "hc", id: "t3" })?.key).toBe("old-lane");
  });

  test("run twice, the result is identical; reading writes nothing, saving keeps paneId/tabId and saves the same bytes again", () => {
    const { d, laneFile } = oldHome();
    const before = readFileSync(laneFile, "utf8");
    const first = { lane: d.store.lane("old-lane"), lanes: d.store.lanes(), roles: d.store.roles() };
    const second = { lane: d.store.lane("old-lane"), lanes: d.store.lanes(), roles: d.store.roles() };
    expect(second).toEqual(first);
    expect(readFileSync(laneFile, "utf8")).toBe(before);
    d.store.saveLane(first.lane!);
    const saved = readFileSync(laneFile, "utf8");
    expect(JSON.parse(saved)).toMatchObject({ paneId: "t3", tabId: "t3", sessionRef: first.lane!.sessionRef });
    d.store.saveLane(d.store.lane("old-lane")!);
    expect(readFileSync(laneFile, "utf8")).toBe(saved);
    expect(d.store.lane("old-lane")).toEqual(first.lane!);
  });

  test("roles are written back as bare addresses, so the binary that wrote the old records still reads them", () => {
    const { d } = oldHome();
    d.store.setRole("duty", { runtime: "hc", id: "t9" });
    expect(JSON.parse(readFileSync(join(d.store.root, "roles.json"), "utf8"))).toEqual({ lead: "t1", duty: "t9" });
  });

  test("dori status shows the old lane as t3 on hc, the way it prints roles", async () => {
    const { d } = oldHome();
    const { out } = await captureIo(async () => {
      status(d);
      return 0;
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("RUNTIME hc (from config)");
    expect(lines[1]).toStartWith("lead=t1 duty=t2 ");
    expect(lines.find((l) => l.startsWith("old-lane"))).toMatch(/^old-lane\s+working\s+hc\s+t3\s/);
  });
});
