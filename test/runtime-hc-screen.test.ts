import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { terminal } from "./fake-hc.ts";
import { rig, T1 } from "./hc-rig.ts";

// #178: omo reports `working` over OSC 7501 while any monitor is live, even between turns. On hc, the probe reads the
// screen (the #62 check) and believes `idle` only when omo's idle input is positively on screen.
const screen = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", "screens", `${name}.txt`), "utf8");
const omoWorking = (name?: string) =>
  terminal({ status: { state: "working", app: "omo" }, ...(name === undefined ? {} : { screen: screen(name) }) });
const reads = (calls: readonly string[][]) => calls.filter((c) => c[0] === "read");
const sends = (calls: readonly string[][]) => calls.filter((c) => c[0] === "send");

describe("probe: the #62 screen check on hc", () => {
  test("working with omo's idle input on screen (live monitors between turns) probes idle", async () => {
    const { fake, rt } = rig({ t1: omoWorking("omo-idle-live-monitors") });
    expect((await rt.probe(T1)).status).toBe("idle");
    expect(reads(fake.calls)).toEqual([["read", "t1", "--lines", "30"]]);
  });

  test.each(["omo-turn", "omo-dialog", "omo-draft"])("working with %s on screen stays working", async (name) => {
    const { rt } = rig({ t1: omoWorking(name) });
    expect((await rt.probe(T1)).status).toBe("working");
  });

  test("a failed screen read stays working (doubt never reads as idle)", async () => {
    const { fake, rt } = rig({ t1: omoWorking("omo-idle-live-monitors") });
    fake.knobs.readError = "unavailable";
    expect((await rt.probe(T1)).status).toBe("working");
  });

  test("an empty screen stays working", async () => {
    const { rt } = rig({ t1: omoWorking() });
    expect((await rt.probe(T1)).status).toBe("working");
  });

  test("any word other than working is taken as reported, with no screen read", async () => {
    for (const state of ["idle", "done", "blocked", "error"] as const) {
      const { fake, rt } = rig({ t1: terminal({ status: { state, app: "omo" }, screen: screen("omo-turn") }) });
      expect((await rt.probe(T1)).status).toBe(state);
      expect(reads(fake.calls)).toEqual([]);
    }
  });

  test("a shell in front is never read as idle, whatever the screen shows", async () => {
    const { fake, rt } = rig({
      t1: terminal({
        status: { state: "working", app: "omo" },
        foreground: { name: "zsh", argv: ["-zsh"], pid: 1 },
        screen: screen("omo-idle-live-monitors"),
      }),
    });
    const p = await rt.probe(T1);
    expect(p.status).toBe("working");
    expect(p.shellInFront).toBe(true);
    expect(reads(fake.calls)).toEqual([]);
  });
});

describe("deliver: idle read off the screen while hc still says working", () => {
  test("sends with --if working, so the compare-and-send matches hc's own word, and lands", async () => {
    const { fake, rt } = rig({ t1: omoWorking("omo-idle-live-monitors") });
    expect((await rt.deliver(T1, "[READY] lane")).kind).toBe("delivered");
    expect(sends(fake.calls)).toEqual([["send", "t1", "--if", "working", "--", "[READY] lane"]]);
  });

  test("hc refusing the send (omo moved between probe and send) stays not-ready and types nothing", async () => {
    const { fake, rt } = rig({ t1: omoWorking("omo-idle-live-monitors") });
    fake.knobs.sendError = "status_mismatch";
    expect((await rt.deliver(T1, "secret text")).kind).toBe("not-ready");
    expect(fake.sent).toEqual([]);
  });

  test("a turn on screen keeps the existing --if idle gate, which hc refuses while working", async () => {
    const { fake, rt } = rig({ t1: omoWorking("omo-turn") });
    expect(await rt.deliver(T1, "x")).toEqual({ kind: "not-ready", status: "working" });
    expect(sends(fake.calls)).toEqual([["send", "t1", "--if", "idle", "--", "x"]]);
    expect(fake.sent).toEqual([]);
  });

  test("a word that already says idle keeps --if idle", async () => {
    const { fake, rt } = rig({ t1: terminal({ status: { state: "idle", app: "omo" } }) });
    expect((await rt.deliver(T1, "x")).kind).toBe("delivered");
    expect(sends(fake.calls)).toEqual([["send", "t1", "--if", "idle", "--", "x"]]);
  });
});
