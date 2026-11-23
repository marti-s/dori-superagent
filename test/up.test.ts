import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { up } from "../src/cli-up.ts";
import { groupId } from "../src/runtime/group.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

describe("dori up", () => {
  test("four hc terminals in this home's group, all four roles registered by address, and no other binary run", async () => {
    const w = new World();
    const d = w.deps();
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    const runs = w.calls.filter((c) => c.cmd === "hc" && c.argv[1] === "run").map((c) => c.argv);
    expect(runs).toHaveLength(4);
    for (const argv of runs) expect(argv).toContain(`dori.group=${groupId(d.store.root)}`);
    expect(runs.map((a) => a.find((x) => x.startsWith("dori.role=")))).toEqual([
      "dori.role=lead",
      "dori.role=duty",
      "dori.role=duty-loop",
      "dori.role=hourly-loop",
    ]);
    expect(w.calls.every((c) => c.cmd === "hc")).toBe(true);
    expect(w.hc.calls.filter((c) => c[0] === "send").map((c) => c.at(-1))).toEqual([
      expect.stringContaining("lead.md"),
      expect.stringContaining("duty.md"),
      "dori duty --interval 60",
      "dori loop",
    ]);
    expect(JSON.parse(readFileSync(join(d.store.root, "roles.json"), "utf8"))).toEqual({
      lead: "t1",
      duty: "t2",
      "duty-loop": "t3",
      "hourly-loop": "t4",
    });
    expect(out).toBe(`UP runtime=hc lead=t1 duty=t2 loop=t3 hourly=t4 home=${d.store.root}`);
  });
});
