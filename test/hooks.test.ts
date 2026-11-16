import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { up } from "../src/cli-up.ts";
import { dutyTick } from "../src/duty.ts";
import { review } from "../src/gate.ts";
import { prompt, type Deps } from "../src/harness.ts";
import { ConfigError, hooksSettled, loadHooks, runHook, substitute } from "../src/hooks.ts";
import { ready, report, startLane } from "../src/lanes.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

const config = (d: Deps, value: unknown) => writeFileSync(join(d.store.root, "config.json"), JSON.stringify(value));
const hookCalls = (w: World, cmd: string) => w.calls.filter((c) => c.cmd === cmd).map((c) => [c.cmd, ...c.argv]);

function captureStderr() {
  const lines: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  delete process.env["DORI_PROMPTS_DIR"];
});

describe("hook config and placeholders", () => {
  test("placeholders are substituted per element; spaces and $( stay literal; unknown braces are kept", () => {
    const argv = substitute(["my-hook", "{key}", "--text={text}", "{evidence}", "{other}", "{pr}"], {
      key: "k",
      text: "two words $(rm -rf /) `x`",
      evidence: "a b",
    });
    expect(argv).toEqual(["my-hook", "k", "--text=two words $(rm -rf /) `x`", "a b", "{other}", "{pr}"]);
  });

  test("absent file or absent hooks key = no hooks; other keys are tolerated", () => {
    const { d } = setup();
    expect(loadHooks(d.store.root)).toEqual({});
    config(d, { runtime: "hc", hooks: { onReady: ["x", "{key}"], unrelated: 1 } });
    expect(loadHooks(d.store.root)).toEqual({ onReady: ["x", "{key}"] });
  });

  test("a non-array or a non-string element is a ConfigError naming the key", async () => {
    const { w, d } = setup();
    config(d, { hooks: { onReady: "not-an-array" } });
    expect(() => loadHooks(d.store.root)).toThrow(ConfigError);
    expect(() => loadHooks(d.store.root)).toThrow("hooks.onReady");
    config(d, { hooks: { reviewCommand: ["rev", 7] } });
    expect(() => loadHooks(d.store.root)).toThrow("hooks.reviewCommand");
    await expect(review(d, "o/r#1")).rejects.toThrow(ConfigError);
    expect(w.calls.some((c) => c.cmd === "gh")).toBe(false);
    config(d, { hooks: [] });
    expect(() => loadHooks(d.store.root)).toThrow("hooks must be an object");
  });
});

describe("lifecycle hooks", () => {
  test("onReport runs after the record is saved, with the exact argv", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "lane-k", brief, { group: "w1" });
    config(d, { hooks: { onReport: ["my-hook", "report", "{key}", "{text}"] } });
    await report(d, "lane-k", "half way $(there)", "waiting");
    await hooksSettled();
    expect(hookCalls(w, "my-hook")).toEqual([["my-hook", "report", "lane-k", "half way $(there)"]]);
    expect(d.store.lane("lane-k")!.status).toBe("waiting");
  });

  test("onReady runs after the lead delivery, with the exact argv", async () => {
    const { w, d, lead, brief } = setup();
    await startLane(d, "lane-k", brief, { group: "w1" });
    config(d, { hooks: { onReady: ["my-hook", "ready", "{key}", "{text}", "{evidence}"] } });
    await ready(d, "lane-k", "final answer", ["https://x/pull/1", "receipt.txt"]);
    await hooksSettled();
    expect(lead.received.at(-1)).toStartWith("[READY lane-k] final answer");
    expect(hookCalls(w, "my-hook")).toEqual([
      ["my-hook", "ready", "lane-k", "final answer", "https://x/pull/1 receipt.txt"],
    ]);
    const hookAt = w.calls.findIndex((c) => c.cmd === "my-hook");
    const leadAt = w.calls.findLastIndex((c) => c.argv[0] === "agent" && c.argv[2] === "w1:p1");
    expect(leadAt).toBeLessThan(hookAt);
  });

  test("onLost runs when the duty loop records a lost lane", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "gone-lane", brief, { group: "w1" });
    config(d, { hooks: { onLost: ["my-hook", "lost", "{key}", "{text}"] } });
    w.panes.delete(lane.paneId);
    expect(await dutyTick(d)).toContainEqual({ lane: "gone-lane", action: "lost" });
    await hooksSettled();
    expect(hookCalls(w, "my-hook")).toEqual([["my-hook", "lost", "gone-lane", "pane disappeared without READY"]]);
    expect(d.store.lane("gone-lane")!.status).toBe("lost");
  });

  test("a hook exiting 1 leaves `dori ready` exit 0 and prints one stderr line", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "lane-k", brief, { group: "w1" });
    config(d, { hooks: { onReady: ["my-hook", "{key}"] } });
    w.reviewer = () => ({ code: 1, stdout: "", stderr: "boom: webhook refused\nsecond line" });
    const err = captureStderr();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["ready", "lane-k", "--text", "done", "--evidence", "e.txt"], d)).toBe(0);
      await hooksSettled();
    } finally {
      err.restore();
      log.mockRestore();
    }
    expect(err.lines).toEqual(["dori: hook onReady failed (boom: webhook refused)\n"]);
    expect(d.store.lane("lane-k")!.status).toBe("ready");
  });

  test("a thrown spawn error and a broken config are one stderr line each, never a throw", async () => {
    const { w, d } = setup();
    config(d, { hooks: { onLost: ["no-such-binary"] } });
    const exec = w.exec;
    const failing: Deps = {
      ...d,
      exec: async (cmd, argv) =>
        cmd === "no-such-binary" ? Promise.reject(new Error("ENOENT: spawn\nmore")) : exec(cmd, argv),
    };
    const err = captureStderr();
    try {
      await runHook(failing, "onLost", { key: "k" });
      config(d, { hooks: { onLost: "x" } });
      await runHook(failing, "onLost", { key: "k" });
    } finally {
      err.restore();
    }
    expect(err.lines).toHaveLength(2);
    expect(err.lines[0]).toBe("dori: hook onLost failed (ENOENT: spawn)\n");
    expect(err.lines[1]).toStartWith("dori: hook onLost failed (config.json: hooks.onLost must be");
  });
});

describe("reviewCommand and DORI_PROMPTS_DIR", () => {
  const head = "b".repeat(40);

  test("reviewCommand replaces the built-in reviewer; its VERDICT is parsed and the receipt says model hook", async () => {
    const { w, d } = setup();
    w.gh = (argv) =>
      argv[1] === "view" ? { code: 0, stdout: JSON.stringify({ headRefOid: head }) } : { code: 1, stdout: "" };
    config(d, { hooks: { reviewCommand: ["my-reviewer", "{repo}", "{number}", "{sha}", "{pr}"] } });
    w.reviewer = () => ({ code: 0, stdout: "looked\nVERDICT: BLOCK\nVERDICT: CLEAR" });
    expect(await review({ ...d, agentCmd: "'unterminated" }, "o/r#5", "ignored/model")).toEqual({
      verdict: "CLEAR",
      sha: head,
    });
    expect(hookCalls(w, "my-reviewer")).toEqual([["my-reviewer", "o/r", "5", head, "o/r#5"]]);
    expect(w.calls.some((c) => c.cmd === "omo")).toBe(false);
    expect(d.store.receipt("o/r#5", head)).toMatchObject({ verdict: "CLEAR", model: "hook" });
    w.reviewer = () => ({ code: 0, stdout: "no verdict here" });
    await expect(review(d, "o/r#5")).rejects.toThrow("reviewer printed no VERDICT line");
  });

  test("DORI_PROMPTS_DIR overrides prompt() and the prompts dori up renders", async () => {
    const { w, d } = setup();
    const dir = mkdtempSync(join(tmpdir(), "dori-prompts-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "nudge.md"), "custom nudge for {{key}}");
    for (const name of ["lead.md", "duty.md"]) writeFileSync(join(dir, name), `custom ${name} via {{dori}}`);
    expect(prompt("nudge.md", { key: "k" })).not.toBe("custom nudge for k");
    process.env["DORI_PROMPTS_DIR"] = dir;
    expect(prompt("nudge.md", { key: "k" })).toBe("custom nudge for k");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await up(d, d.store.root);
    } finally {
      log.mockRestore();
    }
    expect(readFileSync(join(d.store.root, "prompts", "lead.md"), "utf8")).toBe("custom lead.md via dori");
    expect(readFileSync(join(d.store.root, "prompts", "duty.md"), "utf8")).toBe("custom duty.md via dori");
    expect(w.calls.length).toBeGreaterThan(0);
  });
});

describe("hooks never block a command", () => {
  test("hooksSettled returns at its deadline while a hook still runs, printing one timed-out line", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "lane-k", brief, { group: "w1" });
    let release: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.hang = hang;
    config(d, { hooks: { onReport: ["slow-hook", "{key}"] } });
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await report(d, "lane-k", "still going");
      const started = Date.now();
      await hooksSettled(50);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      process.stderr.write = original;
      release?.();
    }
    expect(lines.filter((l) => l.includes("hook onReport failed (timed out after 50 ms)"))).toHaveLength(1);
  });

  test("a hook still running at the deadline is killed before its timed-out line, and its exit adds no second line", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "lane-k", brief, { group: "w1" });
    w.hang = new Promise<void>(() => {});
    const events: string[] = [];
    w.onHookKill = () => events.push("kill");
    config(d, { hooks: { onReport: ["slow-hook", "{key}"] } });
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      events.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await report(d, "lane-k", "still going");
      await hooksSettled(50);
      // The killed hook settles now; waiting for it again must not print its exit 143.
      await hooksSettled(1000);
    } finally {
      process.stderr.write = original;
    }
    expect(events).toEqual(["kill", "dori: hook onReport failed (timed out after 50 ms)\n"]);
  });
});
