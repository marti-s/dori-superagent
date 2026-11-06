import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { send } from "../src/harness.ts";
import { omoScreenIdle } from "../src/terminal.ts";
import { World } from "./fake.ts";

// Real omo screens captured from live omo panes, sanitized (titles, costs, ids, paths replaced).
const screen = (name: string) => Bun.file(join(import.meta.dir, "fixtures", "screens", `${name}.txt`)).text();

describe("omoScreenIdle (#62: an omo with live monitors between turns is idle)", () => {
  test("idle input rule between turns, monitors still live: idle", async () => {
    expect(omoScreenIdle(await screen("omo-idle-live-monitors"))).toBe(true);
  });

  test("a real turn shows esc to interrupt: not idle", async () => {
    expect(omoScreenIdle(await screen("omo-turn"))).toBe(false);
  });

  test("doubt keeps it working: dialog, draft in the input, no box, unknown layout, empty read", async () => {
    expect(omoScreenIdle(await screen("omo-dialog"))).toBe(false);
    expect(omoScreenIdle(await screen("omo-draft"))).toBe(false);
    expect(omoScreenIdle("$ ls\nREADME.md\n$ ")).toBe(false);
    expect(omoScreenIdle("──────────\n❯\nsomething else\n")).toBe(false);
    expect(omoScreenIdle("")).toBe(false);
  });

  test("an idle box with esc to interrupt anywhere on the screen is not idle", async () => {
    expect(omoScreenIdle("── • Working (9s • esc to interrupt) ──\n" + (await screen("omo-idle-live-monitors")))).toBe(false);
  });

  test("an idle box scrolled up above other output is not the bottom of the screen: not idle", async () => {
    const idle = await screen("omo-idle-live-monitors");
    expect(omoScreenIdle(idle + "\n".repeat(2) + ["more", "output", "below", "the", "box"].join("\n"))).toBe(false);
  });
});

describe("delivery decided by the omo screen", () => {
  function setup(screenText?: string) {
    const w = new World();
    const d = w.deps();
    const lead = w.addPane("t1", "working");
    lead.screen = screenText;
    lead.readFails = screenText === undefined;
    d.store.setRole("lead", "t1");
    return { w, d, lead };
  }

  test("live monitors and an idle screen: the message is delivered", async () => {
    const { d, lead } = setup(await screen("omo-idle-live-monitors"));
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello"]);
  });

  test("a real turn: the message is queued and nothing is typed", async () => {
    const { w, d, lead } = setup(await screen("omo-turn"));
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    expect(w.calls.some((c) => c.argv[0] === "send" || c.argv[0] === "keys")).toBe(false);
  });

  test("a failed screen read keeps the message queued", async () => {
    const { d, lead } = setup(undefined);
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
  });

  test("a question or permission prompt is blocked, never idle: the message is queued and nothing is typed", async () => {
    const { w, d, lead } = setup("Question\nAllow this command? [y/n]");
    expect(await d.herdr.status("t1")).toBe("blocked");
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    expect(w.calls.some((c) => c.argv[0] === "send" || c.argv[0] === "keys")).toBe(false);
  });
});
