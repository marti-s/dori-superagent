import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { send } from "../src/inbox.ts";
import { World, sref } from "./fake.ts";

// Real omo screens captured from a terminal, sanitized (titles, costs, ids, paths replaced).
const screen = (name: string) => Bun.file(join(import.meta.dir, "fixtures", "screens", `${name}.txt`)).text();

describe("delivery to a pane whose agent reports working", () => {
  function setup(screenText?: string) {
    const w = new World();
    const d = w.deps();
    const lead = w.addPane("t1", "working");
    lead.screen = screenText;
    d.store.setRole("lead", sref("t1"));
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
    expect(w.hcCalls("send", "t1")).toEqual([]);
  });

  test("a failed screen read keeps the message queued", async () => {
    const { d, lead } = setup(undefined);
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
  });

  test("blocked is never read as idle, whatever the screen shows", async () => {
    const { w, d, lead } = setup(await screen("omo-idle-live-monitors"));
    lead.status = "blocked";
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(w.calls.some((c) => c.argv[1] === "read")).toBe(false);
  });
});
