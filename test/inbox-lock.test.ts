import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { send } from "../src/inbox.ts";
import { flushInbox } from "../src/inbox.ts";
import { INBOX_LOCK_STALE_MS } from "../src/store-types.ts";
import { setup } from "./inbox-setup.ts";
import { sref } from "./fake.ts";

// #108: follow-ups to #89 (PR 102).

describe("one flush per pane (#108 3)", () => {
  const lockPath = (s: ReturnType<typeof setup>) => `${s.d.store.inboxPath(sref("t2"))}.lock`;

  test("while another flush holds the pane's lock, flushInbox returns queued and delivers nothing", async () => {
    const s = setup();
    s.pane.status = "working";
    await send(s.d, "t2", "once", "cli");
    s.pane.status = "idle";
    const release = s.d.store.lockInbox(sref("t2"), s.w.clock)!;
    expect(release).toBeDefined();
    expect(await flushInbox(s.d, sref("t2"))).toBe("queued");
    expect(await dutyTick(s.d)).toEqual([]);
    expect(s.pane.received).toEqual([]);
    expect(s.d.store.queued(sref("t2"))).toHaveLength(1);
    release();
    expect(await flushInbox(s.d, sref("t2"))).toBe("delivered");
    expect(s.pane.received).toEqual(["once"]);
    expect(existsSync(lockPath(s))).toBe(false);
  });

  test("two concurrent flushInbox calls: the second, started while the first is inside, returns queued; one delivery", async () => {
    const s = setup();
    s.pane.status = "working";
    await send(s.d, "t2", "once", "cli");
    s.pane.status = "idle";
    let second: Promise<string> | undefined;
    // The first flush's second `hc get` starts the second flush: both are in flight at the same time, with no timing.
    s.w.getHook.set("t2", (n) => {
      if (n === 2) second = flushInbox(s.d, sref("t2"));
    });
    const first = await flushInbox(s.d, sref("t2"));
    expect(second).toBeDefined();
    expect([first, await second]).toEqual(["delivered", "queued"]);
    expect(s.w.hcCalls("send", "t2")).toHaveLength(1);
    expect(s.pane.received).toEqual(["once"]);
  });

  test("a lock held by a dead pid on this host, or older than 60 s from another host, is taken over", async () => {
    const s = setup();
    const exited = Bun.spawn(["true"]);
    await exited.exited;
    for (const stale of [
      { pid: 1, host: "other-host", at: s.w.clock - INBOX_LOCK_STALE_MS - 1 },
      { pid: exited.pid, host: hostname(), at: s.w.clock },
    ]) {
      s.d.store.enqueue(sref("t2"), { at: s.w.clock, from: "cli", text: `m${stale.host === "other-host" ? 1 : 2}` });
      writeFileSync(lockPath(s), JSON.stringify(stale));
      expect(await flushInbox(s.d, sref("t2"))).toBe("delivered");
      expect(existsSync(lockPath(s))).toBe(false);
    }
    expect(s.pane.received).toEqual(["m1", "m2"]);
  });

  test("a fresh lock on another host, or a live pid on this host however old its lock, is not taken over", async () => {
    const s = setup();
    s.d.store.enqueue(sref("t2"), { at: s.w.clock, from: "cli", text: "wait" });
    for (const live of [
      { pid: 1, host: "other-host", at: s.w.clock },
      { pid: process.pid, host: hostname(), at: s.w.clock - 1000 },
      // A live flush stuck in a slow hc call for longer than the stale age still owns the pane.
      { pid: process.pid, host: hostname(), at: s.w.clock - INBOX_LOCK_STALE_MS - 60_000 },
    ]) {
      writeFileSync(lockPath(s), JSON.stringify(live));
      expect(await flushInbox(s.d, sref("t2"))).toBe("queued");
    }
    expect(s.pane.received).toEqual([]);
  });

  test("the lock is released when the flush throws, and ack refuses while a flush holds it", async () => {
    const s = setup();
    s.d.store.saveInbox(sref("t2"), [{ at: 0, from: "cli", text: "held", attempt: { at: 1, state: "ambiguous" } }]);
    const release = s.d.store.lockInbox(sref("t2"), s.w.clock)!;
    await expect(main(["inbox", "ack", "t2", "1"], s.d)).rejects.toThrow(/being flushed/);
    release();
    s.w.panes.delete("t2");
    await expect(flushInbox(s.d, sref("t2"))).rejects.toThrow(/gone/);
    expect(existsSync(lockPath(s))).toBe(false);
  });
});
