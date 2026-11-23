import { describe, expect, test } from "bun:test";
import type { SessionRef } from "../src/runtime/types.ts";
import { terminal } from "./fake-hc.ts";
import { rig } from "./hc-rig.ts";

const T7: SessionRef = { runtime: "hc", id: "t7" };
/** Terminal t7 as Dori started it for lane `fix-login`, in its own tab of the Herdr window. */
const laneRig = (over: Parameters<typeof terminal>[0] = {}) => {
  const r = rig({ t7: terminal({ argv: ["env", "DORI_LANE=fix-login", "DORI_HOME=/h", "/bin/zsh"], ...over }) });
  r.fake.tabs.set("t7", { id: "tb-7", name: "fix-login" });
  return r;
};
const verbs = (calls: string[][]) => calls.map((c) => c.slice(0, 2).join(" "));

describe("stop", () => {
  test("ends the program and keeps the terminal's record", async () => {
    const { fake, rt } = laneRig();
    await rt.stop(T7);
    expect(fake.calls).toEqual([["kill", "t7"]]);
    expect(fake.terminals.get("t7")?.state).toBe("finished");
  });

  test("a terminal hc no longer knows is already stopped", async () => {
    const { fake, rt } = rig();
    await rt.stop(T7);
    expect(fake.calls).toEqual([["kill", "t7"]]);
  });
});

describe("retire", () => {
  test("a finished lane terminal is removed and its tab closed", async () => {
    const { fake, rt } = laneRig({ state: "finished" });
    expect(await rt.retire(T7, "fix-login")).toBe("terminal t7 removed; tab tb-7 closed");
    expect(verbs(fake.calls)).toEqual(["get t7", "kill t7", "rm t7"]);
    expect(fake.terminals.has("t7")).toBe(false);
    expect(fake.appCalls).toEqual([["ls"], ["do", "tab.close", "--id", "tb-7", "--confirmed", "true"]]);
    expect([...fake.closedTabs]).toEqual(["tb-7"]);
  });

  test("a terminal still running is killed first", async () => {
    const { fake, rt } = laneRig();
    expect(await rt.retire(T7, "fix-login")).toBe("terminal t7 removed; tab tb-7 closed");
    expect(fake.terminals.has("t7")).toBe(false);
  });

  test.each([
    ["another lane's terminal", ["env", "DORI_LANE=other", "/bin/zsh"]],
    ["a lane whose key only starts the same", ["env", "DORI_LANE=fix-login-2", "/bin/zsh"]],
    ["a terminal Dori did not start", ["zsh"]],
  ])("%s at that address is kept: nothing is killed, removed or closed", async (_name, argv) => {
    const { fake, rt } = laneRig({ argv });
    expect(await rt.retire(T7, "fix-login")).toBe("kept: terminal t7 is not the one dori started for lane fix-login");
    expect(verbs(fake.calls)).toEqual(["get t7"]);
    expect(fake.appCalls).toEqual([]);
    expect(fake.terminals.get("t7")?.state).toBe("live");
  });

  test("a terminal that is already gone still has its tab closed", async () => {
    const { fake, rt } = rig();
    fake.tabs.set("t7", { id: "tb-7", name: "fix-login" });
    expect(await rt.retire(T7, "fix-login")).toBe("terminal t7 already gone; tab tb-7 closed");
    expect(verbs(fake.calls)).toEqual(["get t7"]);
  });

  test("a terminal the window shows in no tab is only removed", async () => {
    const { fake, rt } = laneRig({ state: "finished" });
    fake.tabs.clear();
    expect(await rt.retire(T7, "fix-login")).toBe("terminal t7 removed; no app tab held it");
    expect(fake.appCalls).toEqual([["ls"]]);
  });

  test("a tab that still holds another live terminal is kept; one holding only finished terminals is closed", async () => {
    const shared = laneRig({ state: "finished" });
    shared.fake.terminals.set("t8", terminal());
    shared.fake.tabs.set("t8", { id: "tb-7", name: "fix-login" });
    expect(await shared.rt.retire(T7, "fix-login")).toBe("terminal t7 removed; tab tb-7 kept: it holds live t8");
    expect(shared.fake.closedTabs.size).toBe(0);
    const dead = laneRig({ state: "finished" });
    dead.fake.terminals.set("t8", terminal({ state: "finished" }));
    dead.fake.tabs.set("t8", { id: "tb-7", name: "fix-login" });
    expect(await dead.rt.retire(T7, "fix-login")).toBe("terminal t7 removed; tab tb-7 closed");
  });

  test.each(["missing", "fail"] as const)(
    "herdr-app %s: the terminal is still removed and the reason is named",
    async (app) => {
      const { fake, rt } = laneRig({ state: "finished" });
      fake.knobs.app = app;
      expect(await rt.retire(T7, "fix-login")).toStartWith("terminal t7 removed; tab not closed: ");
      expect(fake.terminals.has("t7")).toBe(false);
    },
  );

  test("a close the window refuses because it already dropped the tab counts as closed", async () => {
    const { fake, rt } = laneRig({ state: "finished" });
    fake.knobs.windowDropsRemoved = true;
    expect(await rt.retire(T7, "fix-login")).toBe("terminal t7 removed; tab tb-7 closed");
    expect(fake.appCalls).toEqual([["ls"], ["do", "tab.close", "--id", "tb-7", "--confirmed", "true"], ["ls"]]);
    expect(fake.closedTabs.size).toBe(0);
  });
});
