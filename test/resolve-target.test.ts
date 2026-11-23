import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTarget } from "../src/target.ts";
import { Refusal } from "../src/refusal.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import type { Lane } from "../src/store-types.ts";
import { World } from "./fake.ts";

const lane = (key: string, sessionRef: SessionRef, status: Lane["status"] = "working"): Lane => ({
  key,
  sessionRef,
  paneId: sessionRef.id,
  tabId: "",
  brief: "/b.md",
  cwd: "/w",
  status,
  createdAt: 0,
  lastActivityAt: 0,
  nudges: 0,
  log: [],
});

function setup() {
  const d = new World().deps();
  writeFileSync(join(d.store.root, "roles.json"), JSON.stringify({ lead: "t1", duty: "hc:t2" }));
  d.store.saveLane(lane("t7", { runtime: "hc", id: "t5" }));
  d.store.saveLane(lane("t8", { runtime: "hc", id: "t9" }, "done"));
  return d;
}

describe("resolveTarget: prefixed ref, role, open lane key, bare hc address", () => {
  test.each([
    ["hc:t7", { runtime: "hc", id: "t7" }],
    ["t3", { runtime: "hc", id: "t3" }],
    ["lead", { runtime: "hc", id: "t1" }],
    ["duty", { runtime: "hc", id: "t2" }],
    ["t7", { runtime: "hc", id: "t5" }],
  ] as const)("%s", (target, want) => {
    expect(resolveTarget(setup(), target)).toEqual(want);
  });

  test("a lane named t7 wins over the hc terminal t7, which needs its prefix", () => {
    const d = setup();
    expect(resolveTarget(d, "t7")).toEqual({ runtime: "hc", id: "t5" });
    expect(resolveTarget(d, "hc:t7")).toEqual({ runtime: "hc", id: "t7" });
  });

  test("the key of a done lane is a terminal address again, not the lane's old session", () => {
    expect(resolveTarget(setup(), "t8")).toEqual({ runtime: "hc", id: "t8" });
  });

  test.each([
    ["nobody", "unknown target nobody"],
    ["w1:p3", "unknown target w1:p3"],
    ["hc:w1:p3", "not a session ref"],
    ["hc:machine/t7", "not a session ref"],
    ["hourly-loop", "no hourly-loop session registered"],
  ])("%s is refused: %s", (target, why) => {
    expect(() => resolveTarget(setup(), target)).toThrow(Refusal);
    expect(() => resolveTarget(setup(), target)).toThrow(why);
  });
});
