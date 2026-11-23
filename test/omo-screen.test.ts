import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { omoScreenIdle } from "../src/runtime/screen.ts";

const screen = (name: string) => Bun.file(join(import.meta.dir, "fixtures", "screens", `${name}.txt`)).text();

describe("omoScreenIdle (#62: an omo with live monitors reports working between turns)", () => {
  test("idle input rule between turns, monitors still live: idle; a real turn: not idle", async () => {
    expect(omoScreenIdle(await screen("omo-idle-live-monitors"))).toBe(true);
    expect(omoScreenIdle(await screen("omo-turn"))).toBe(false);
  });

  test("doubt keeps it working: dialog, draft in the input, no box, unknown layout, empty read", async () => {
    expect(omoScreenIdle(await screen("omo-dialog"))).toBe(false);
    expect(omoScreenIdle(await screen("omo-draft"))).toBe(false);
    expect(omoScreenIdle("$ ls\nREADME.md\n$ ")).toBe(false);
    expect(omoScreenIdle("──────────\n❯\nsomething else\n")).toBe(false);
    expect(omoScreenIdle("")).toBe(false);
  });

  test("esc to interrupt anywhere, or an idle box scrolled up above other output, is not idle", async () => {
    const idle = await screen("omo-idle-live-monitors");
    expect(omoScreenIdle("── • Working (9s • esc to interrupt) ──\n" + idle)).toBe(false);
    expect(omoScreenIdle(idle + "\n".repeat(2) + ["more", "output", "below", "the", "box"].join("\n"))).toBe(false);
  });
});
