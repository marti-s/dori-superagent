import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { memFreePct } from "../src/host.ts";
import { HOUR, loopTick, msUntilNext } from "../src/loop.ts";
import { restore } from "../src/loop-lock.ts";
import { setup } from "./loop-setup.ts";

describe("hourly loop", () => {
  test("kill switch: a stopped loop does nothing at all; a live lock skips, a dead or corrupt one is taken over", async () => {
    const { w, d, lead, add, tick } = setup();
    add("work");
    d.store.setStop(1, "maintenance");
    lead.received.length = 0;
    const stopped = await tick();
    expect(stopped.skipped).toBe("stopped: maintenance");
    expect(d.store.runs()).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(d.store.item("work")!.status).toBe("open");
    d.store.clearStop();

    writeFileSync(d.store.loopPath("lock"), JSON.stringify({ pid: process.ppid, at: 0, nonce: "other" }));
    expect((await tick()).skipped).toBe(`locked by pid ${process.ppid}`);
    expect(readFileSync(d.store.loopPath("lock"), "utf8")).toContain('"other"');
    writeFileSync(d.store.loopPath("lock"), '{"pid": 12');
    expect((await tick()).started).toEqual(["work (p5)"]);
    writeFileSync(d.store.loopPath("lock"), JSON.stringify({ pid: 2147483647, at: 0, nonce: "dead" }));
    w.clock += HOUR;
    expect((await tick()).started).toEqual([]);
    expect(readdirSync(join(d.store.root, "loop")).filter((f) => f.startsWith("lock"))).toEqual([]);
  });

  test("a stopped, locked-out or failing loop waits a full interval; a fresh stamp keeps the hourly cadence", async () => {
    const { w, d, add, tick } = setup();
    expect(msUntilNext(d, HOUR)).toBe(HOUR);
    add("cadence");
    await tick();
    w.clock += 20 * 60_000;
    expect(msUntilNext(d, HOUR)).toBe(40 * 60_000);
    w.clock += 3 * HOUR;
    d.store.setStop(w.clock, "pause");
    expect((await loopTick(d)).skipped).toBe("stopped: pause");
    expect(msUntilNext(d, HOUR)).toBe(HOUR);
  });
});

describe("hardening", () => {
  test("a loop that loses its lock mid-run starts nothing more and leaves the new holder's lock in place", async () => {
    let home = "";
    const { d, add, tick } = setup({
      exec: (inner) => async (cmd, argv) => {
        if (cmd === "hc" && argv[1] === "run") {
          writeFileSync(join(home, "loop", "lock"), JSON.stringify({ pid: process.ppid, at: 0, nonce: "usurper" }));
        }
        return inner(cmd, argv);
      },
    });
    home = d.store.root;
    add("first");
    add("second");
    const run = await tick({ maxStarts: 2 });
    expect(run.started).toEqual(["first (p5)"]);
    expect(run.held).toContain("lock lost to another loop; no more starts this run");
    expect(readFileSync(d.store.loopPath("lock"), "utf8")).toContain("usurper");
  });

  test("a moved lock that cannot be put back because a newer one exists is left aside, never deleted", () => {
    const { d } = setup();
    const path = d.store.loopPath("lock");
    const aside = `${path}.release.x`;
    writeFileSync(aside, JSON.stringify({ pid: 1, at: 0, nonce: "moved" }));
    writeFileSync(path, JSON.stringify({ pid: 2, at: 0, nonce: "newer" }));
    restore(aside, path);
    expect(readFileSync(path, "utf8")).toContain("newer");
    expect(readFileSync(aside, "utf8")).toContain("moved");
    rmSync(path);
    restore(aside, path);
    expect(readFileSync(path, "utf8")).toContain("moved");
    expect(readdirSync(join(d.store.root, "loop")).filter((f) => f.includes(".release."))).toEqual([]);
  });

  test("macOS memory uses the kernel's available level, not free pages; Linux and a broken sysctl fall back to freemem", () => {
    const free = () => 3;
    expect(memFreePct("darwin", () => "72\n", free)).toBe(72);
    expect(
      memFreePct(
        "linux",
        () => {
          throw new Error("must not be called on linux");
        },
        free,
      ),
    ).toBe(3);
    expect(
      memFreePct(
        "darwin",
        () => {
          throw new Error("no sysctl");
        },
        free,
      ),
    ).toBe(3);
    expect(memFreePct("darwin", () => "garbage", free)).toBe(3);
  });

  test("two runs in the same millisecond keep two records", async () => {
    const { d, tick } = setup();
    await tick();
    await tick();
    expect(d.store.runs()).toHaveLength(2);
  });

  test("loop status says armed with the age of the last run, never that a process is running", async () => {
    const { w, d, tick } = setup();
    const status = async (): Promise<string> => {
      const lines: string[] = [];
      const log = console.log;
      console.log = (...a: unknown[]) => void lines.push(a.join(" "));
      try {
        expect(await main(["loop", "status"], d)).toBe(0);
      } finally {
        console.log = log;
      }
      return lines[0]!;
    };

    expect(await status()).toBe("armed (no stop file; no run recorded yet)");
    await tick();
    w.clock += 10 * 60_000;
    expect(await status()).toBe("armed (no stop file; last run 10m ago)");
    d.store.setStop(d.now(), "maintenance");
    expect(await status()).toBe("stopped: maintenance");
  });
});
