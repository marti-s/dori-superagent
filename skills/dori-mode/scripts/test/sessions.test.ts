import { afterEach, beforeEach, expect, test } from "bun:test";

import type { SessionRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { runtimesFor, runtimesOf } from "../src/run.ts";
import { listSessions, sendVerified, shellInFront, UnsafeTextError } from "../src/sessions.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const P1: SessionRef = { runtime: "hc", id: "w:p1" };
const T1: SessionRef = { runtime: "hc", id: "t1" };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number, patch: Partial<FlowDeps["config"]> = {}) => depsFor(world, fakeClock(ms), state.dir, patch);
const send = (text: string, ref: SessionRef = P1) => sendVerified(runtimesOf(at(T0)), at(T0).clock, ref, text);
/** Every time hc was asked to type into a terminal or press a key in it. */
const typedKeys = () => world.calls.filter((c) => c[2] === "send" || c[2] === "keys");

beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

test("delivery is confirmed by the pane's agent status moving to working, with exactly one send", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.onEnterStatus = "working";
  expect(await send("[LEAD] please report")).toBe("delivered");
  expect(typedKeys()).toHaveLength(1);
  expect(sent(world)).toEqual(["[LEAD] please report"]);
});

test("a screen that still shows the text never causes another send; no status change is unconfirmed", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.stuckReads = 10;
  expect(await send("[LEAD] stuck text still here")).toBe("unconfirmed");
  expect(typedKeys()).toHaveLength(1);
});

test("a pane that was already working cannot show a change, so the send is unconfirmed, not delivered", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "working" }];
  expect(await send("[LEAD] queued while busy")).toBe("unconfirmed");
  expect(typedKeys()).toHaveLength(1);
});

test("a pane with no running agent is a bare shell: nothing is typed, the send fails", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }];
  expect(await send("[LEAD] please report")).toBe("failed");
  world.panes = [];
  expect(await send("[LEAD] please report")).toBe("failed");
  expect(typedKeys()).toHaveLength(0);
});

test("an agent suspended with Ctrl+Z is still reported idle, but the shell is in front: nothing is typed", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "opencode", agent_status: "idle", foreground: "-zsh" }];
  expect(await shellInFront(runtimesOf(at(T0)), P1)).toBe(true);
  expect(await send("[LEAD] please report")).toBe("failed");
  expect(typedKeys()).toHaveLength(0);
});

test("an agent with a non-interactive sh -c child in front is delivered to; a foreground hc cannot report is doubt", async () => {
  const pi = { pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" };
  world.panes = [{ ...pi, foreground: { name: "sh", argv: ["sh", "-c", "true"] } }];
  world.onEnterStatus = "working";
  expect(await shellInFront(runtimesOf(at(T0)), P1)).toBe(false);
  expect(await send("[LEAD] one")).toBe("delivered");
  world.panes = [{ ...pi, foreground: null }];
  const before = sent(world).length;
  expect(await send("[LEAD] two")).toBe("failed");
  expect(sent(world).length).toBe(before);
});

test("a failed pane lookup is doubt: nothing is typed, the send fails", async () => {
  const deps = at(T0);
  const typed: (readonly string[])[] = [];
  const run = async (argv: readonly string[]) => {
    if (argv[0] === "hc" && argv[2] === "ls") return { code: 1, out: "", err: "hc down" };
    if (argv[2] === "send" || argv[2] === "keys") typed.push(argv);
    return deps.run(argv);
  };
  const rts = runtimesFor(deps.config, {}, run, deps.clock);
  expect(await sendVerified(rts, deps.clock, P1, "[LEAD] please report")).toBe("failed");
  expect(typed).toHaveLength(0);
});

test("text with a backtick never reaches a session", async () => {
  for (const ref of [P1, T1]) await expect(send("run `rm -rf`", ref)).rejects.toBeInstanceOf(UnsafeTextError);
  expect(world.calls).toHaveLength(0);
});

test("a terminal in full form: a send is delivered once the agent's status flips to working, gated on the status read before it", async () => {
  world.terminals = { t1: hcTerm() };
  world.onEnterStatus = "working";
  expect(await send("[LEAD] please report", T1)).toBe("delivered");
  expect(sent(world)).toEqual(["[LEAD] please report"]);
  expect(world.calls.find((c) => c[2] === "send")).toEqual([
    "hc",
    "--json",
    "send",
    "t1",
    "--if",
    "idle",
    "--",
    "[LEAD] please report",
  ]);
});

test("a terminal in full form: a working agent gets the text gated on working and the send is unconfirmed", async () => {
  world.terminals = { t1: hcTerm({ status: { state: "working", app: "omo" } }) };
  expect(await send("[LEAD] queued while busy", T1)).toBe("unconfirmed");
  expect(world.calls.find((c) => c[2] === "send")).toContain("working");
});

test("a terminal in full form: a shell in front fails the send and types nothing, whatever the status word says", async () => {
  world.terminals = { t1: hcTerm({ foreground: { name: "zsh", argv: ["-zsh"], pid: 9 } }) };
  expect(await shellInFront(runtimesOf(at(T0)), T1)).toBe(true);
  expect(await send("[LEAD] please report", T1)).toBe("failed");
  expect(sent(world)).toEqual([]);
  world.terminals = { t1: hcTerm() };
  expect(await shellInFront(runtimesOf(at(T0)), T1)).toBe(false);
});

test("a terminal in full form: a terminal that is gone or blocked gets nothing", async () => {
  expect(await send("[LEAD] please report", T1)).toBe("failed");
  world.terminals = { t1: hcTerm({ status: { state: "blocked", app: "omo" } }) };
  expect(await send("[LEAD] please report", T1)).toBe("failed");
  expect(sent(world)).toEqual([]);
});

test("the lanes' sessions and the selected runtime's are listed together, each once, with one list call", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle", title: "pane lane" }];
  world.terminals = { t1: hcTerm() };
  const lanes = [{ sessionRef: P1 }, { sessionRef: T1 }];
  const listed = await listSessions(runtimesOf(at(T0)), { lanes });
  expect(listed.map((s) => `${s.ref.runtime}:${s.ref.id}:${s.status}`).sort()).toEqual(["hc:t1:idle", "hc:w:p1:idle"]);
  expect(world.calls.filter((c) => c[2] === "ls")).toHaveLength(1);
  // Without any lane the selected runtime is asked just the same.
  expect((await listSessions(runtimesOf(at(T0)))).map((s) => s.ref.id).sort()).toEqual(["t1", "w:p1"]);
});

test("a failed runtime choice still lists a stored lane; with no lane the failure is thrown", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  const deps = { ...at(T0), env: { DORI_RUNTIME: "tmux" } };
  const listed = await listSessions(runtimesOf(deps), { lanes: [{ sessionRef: P1 }] });
  expect(listed.map((s) => `${s.ref.runtime}:${s.ref.id}`)).toEqual(["hc:w:p1"]);
  await expect(listSessions(runtimesOf({ ...at(T0), env: { DORI_RUNTIME: "tmux" } }))).rejects.toThrow();
});
