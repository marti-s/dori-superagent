import { describe, expect, test } from "bun:test";
import { TAB_LOOKUP_MS, TAB_LOOKUPS } from "../src/runtime/hc/app.ts";
import type { CreateSpec, SessionRole } from "../src/runtime/types.ts";
import { type FakeHc, terminal } from "./fake-hc.ts";
import { lane, rig } from "./hc-rig.ts";

const spec = (role: SessionRole, name: string = role): CreateSpec => ({ name, cwd: "/w", env: {}, role });
const UP: readonly CreateSpec[] = [spec("lead", "dori"), spec("duty"), spec("duty-loop"), spec("hourly-loop")];

/** Two app spaces with the same name, one terminal in each. */
const twoSpaces = () => ({
  t1: terminal({ labels: { "herdr.space": "sp-old", where: "work / 1" } }),
  t2: terminal({ labels: { "herdr.space": "sp-new", where: "work / 1" } }),
});
/** `<herdr.space> <where>` of every terminal the runtime created. */
const placed = (fake: FakeHc): string[] =>
  [...fake.terminals]
    .filter(([id]) => id !== "t1" && id !== "t2")
    .map(([, t]) => `${t.labels["herdr.space"]} ${t.labels["where"]}`);

describe("placement in a Herdr app space", () => {
  test("DORI_HERDR_SPACE wins over the starting terminal's space, also when another space has the same name", async () => {
    const { fake, rt } = rig(twoSpaces(), { DORI_HERDR_SPACE: "sp-new", HC_TERMINAL_ID: "t1" });
    for (const s of [...UP, spec("lane", "fix-login")]) await rt.create(s);
    expect(placed(fake)).toEqual([
      "sp-new work / dori-lead",
      "sp-new work / dori-duty",
      "sp-new work / dori-duty-loop",
      "sp-new work / dori-hourly-loop",
      "sp-new work / dori-fix-login",
    ]);
    expect(fake.sent).toEqual([]);
  });

  test("without it, every terminal joins the space of the terminal Dori is started from", async () => {
    const { fake, rt } = rig(twoSpaces(), { HC_TERMINAL_ID: "t2" });
    await rt.create(spec("lead", "dori"));
    await rt.create(spec("lane", "fix-login"));
    expect(placed(fake)).toEqual(["sp-new work / dori-lead", "sp-new work / dori-fix-login"]);
  });

  test("with neither, or from a terminal in no space, the terminal gets no placement and the window is never asked", async () => {
    for (const env of [{}, { HC_TERMINAL_ID: "t3" }, { HC_TERMINAL_ID: "t9" }]) {
      const { fake, rt } = rig({ ...twoSpaces(), t3: terminal() }, env);
      await rt.create(lane);
      const created = [...fake.terminals.values()].at(-1);
      expect(Object.keys(created?.labels ?? {}).filter((k) => k === "herdr.space" || k === "where")).toEqual([]);
      expect(fake.appCalls).toEqual([]);
    }
  });

  test("a DORI_HERDR_SPACE no terminal is in is refused before anything is started", async () => {
    const { fake, rt } = rig(twoSpaces(), { DORI_HERDR_SPACE: "sp-missing" });
    await expect(rt.create(lane)).rejects.toThrow("no hc terminal is in DORI_HERDR_SPACE sp-missing");
    expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
  });
});

describe("the environment of a new terminal", () => {
  test("is the spec's env and nothing else: the adapter adds none of its own caller's variables", async () => {
    const { fake, rt } = rig({}, { DORI_HOME: "/caller/home", DORI_ALLOW: "1", PATH: "/a:/b", SHELL: "/bin/zsh" });
    await rt.create({ ...lane, env: { DORI_LANE: "lane-k" } });
    const run = fake.calls.find((c) => c[0] === "run") ?? [];
    expect(run.slice(run.indexOf("env") + 1)).toEqual(["DORI_LANE=lane-k", "/bin/zsh"]);
  });
});

describe("naming the tab in the Herdr window", () => {
  const inSpace = { HC_TERMINAL_ID: "t2" };

  test("each dori up session's tab is named after its role, a lane's after its key", async () => {
    const { fake, rt } = rig(twoSpaces(), inSpace);
    const refs = [];
    for (const s of [...UP, spec("lane", "fix-login")]) refs.push(await rt.create(s));
    expect(refs.map((r) => fake.tabs.get(r.id)?.name)).toEqual([
      "lead",
      "duty",
      "duty-loop",
      "hourly-loop",
      "fix-login",
    ]);
  });

  test("a tab the window does not list yet is looked up again, 200 ms later", async () => {
    const { fake, rt, sleeps } = rig(twoSpaces(), inSpace);
    fake.knobs.app = "late";
    const ref = await rt.create(lane);
    expect(fake.tabs.get(ref.id)?.name).toBe("Lane K");
    expect(sleeps).toEqual([TAB_LOOKUP_MS]);
    expect(fake.appCalls.map((c) => c[0])).toEqual(["ls", "ls", "do"]);
  });

  test.each(["missing", "fail"] as const)(
    "herdr-app %s: the session is still created, its tab keeps its number, one line is logged",
    async (app) => {
      const { fake, rt, logs, sleeps } = rig(twoSpaces(), inSpace);
      fake.knobs.app = app;
      const ref = await rt.create(lane);
      await rt.start(ref, "omo");
      expect(fake.sent).toEqual([{ id: ref.id, text: "omo" }]);
      expect(fake.tabs.get(ref.id)?.name).toBe("1");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toStartWith(`dori: could not name the app tab of ${ref.id} "Lane K": `);
      expect(sleeps).toEqual([]);
    },
  );

  test("a tab that never appears: looked up 10 times, then given up on without failing the launch", async () => {
    const { fake, rt, logs, sleeps } = rig(twoSpaces(), inSpace);
    fake.knobs.app = "blind";
    const ref = await rt.create(lane);
    expect(ref.id).toBe("t3");
    expect(fake.appCalls).toEqual(Array.from({ length: TAB_LOOKUPS }, () => ["ls"]));
    expect(sleeps).toHaveLength(TAB_LOOKUPS - 1);
    expect(logs).toEqual(['dori: could not name the app tab of t3 "Lane K": no app tab holds the terminal']);
  });

  test("DORI_HERDR_APP names the herdr-app binary; without it the one on PATH is run", async () => {
    const named = rig(twoSpaces(), { ...inSpace, DORI_HERDR_APP: "/opt/herdr/herdr-app" });
    const ref = await named.rt.create(lane);
    expect([...named.fake.appBins]).toEqual(["/opt/herdr/herdr-app"]);
    expect(named.fake.tabs.get(ref.id)?.name).toBe("Lane K");
    const plain = rig(twoSpaces(), inSpace);
    await plain.rt.create(lane);
    expect([...plain.fake.appBins]).toEqual(["herdr-app"]);
  });
});
