import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchLane } from "../src/launch.ts";
import { Reports } from "../src/reports.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

for (const check of [1, 2]) {
  for (const disappearance of ["missing", "read", "list"] as const) {
    for (const done of ["verified", "journal", "none"] as const) {
      test(`startup check ${check}: ${disappearance} with ${done} completion`, async () => {
        const state = withState();
        try {
          const brief = join(state.dir, "brief.md");
          writeFileSync(brief, "brief");
          const world = newWorld();
          let waits = 0;
          const clock = {
            ...fakeClock(Date.parse("2026-01-01T00:00:00Z")),
            sleep: async () => {
              waits++;
              if (waits !== check || done === "none") return;
              const lane = await base.registry.read("fast");
              if (!lane) throw new Error("lane not registered");
              if (done === "verified") await base.registry.write({ ...lane, status: "verified-done" });
              else new Reports(state.dir).report("fast", "done", "finished", clock.now());
            },
          };
          const base = depsFor(world, clock, state.dir, { runtime: "hc" });
          const run = async (argv: readonly string[]) => {
            if (waits === check && argv[0] === "hc" && argv[1] === "--json") {
              if (disappearance === "read" && argv[2] === "read") return { code: 3, out: "", err: "not found" };
              if (argv[2] === "ls" && disappearance === "list") return { code: 3, out: "", err: "not found" };
              if (argv[2] === "ls" && disappearance === "missing")
                return { code: 0, out: JSON.stringify({ terminals: [] }), err: "" };
            }
            const result = await base.run(argv);
            const term = world.terminals["t1"];
            if (argv[0] === "hc" && argv[2] === "send" && term) {
              term.foreground = { name: "omo", argv: ["omo"], pid: 1 };
              term.status = { state: "working", app: "omo" };
            }
            return result;
          };
          const result = await launchLane({ ...base, run }, { key: "fast", title: "t", brief, done: "closed a/b#1" })
            .then((value) => value.startup)
            .catch((error: unknown) => `THREW ${String(error)}`);
          if (done !== "none") expect(result).toBe("STARTUP_DONE fast");
          else if (disappearance === "read") expect(result).toStartWith("THREW HcError");
          else expect(result).toStartWith("STARTUP_UNCONFIRMED fast t1:");
        } finally {
          state.done();
        }
      });
    }
  }
}
