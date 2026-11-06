import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { defaultDeps, resolveTarget } from "../src/harness.ts";
import { HerdrCore } from "../src/herdr-core.ts";
import { DeliveryUncertain } from "../src/terminal.ts";
import { FakeCore, idleScreen } from "./fake-core.ts";

test.each([
  ["idle input", "live", idleScreen, "idle"],
  ["active omo", "live", "Working\nesc to interrupt", "working"],
  ["busy footer", "live", "❯\nWorking", "working"],
  ["question", "live", "Question\nAllow this command? [y/n]", "blocked"],
  ["selection", "live", "enter to select · esc to cancel", "blocked"],
  ["unrecognized screen", "live", "loading...", "unknown"],
  ["finished terminal", "exited", idleScreen, "gone"],
] as const)("core status derives %s", async (_name, state, screen, expected) => {
  const fake = new FakeCore();
  Object.assign(fake.add(), { state, screen });
  expect(await new HerdrCore(fake.exec).status("t1")).toBe(expected);
});

test.each([
  ["foreground shell", { name: "zsh", argv: ["zsh", "-i"] }],
  ["unreadable foreground", null],
] as const)("core holds agent delivery with %s even over an old idle screen", async (_name, foreground) => {
  const fake = new FakeCore();
  const pane = fake.add();
  pane.foreground = foreground ? { name: foreground.name, argv: [...foreground.argv] } : null;
  const core = new HerdrCore(fake.exec);
  expect(await core.status("t1")).toBe("shell");
  expect(await core.deliver("t1", "do not execute")).toBe(false);
  expect(await core.submitTyped("t1")).toBe(false);
  expect(pane.received).toEqual([]);
});

test("core distinguishes a missing terminal from a broken server", async () => {
  const fake = new FakeCore();
  const core = new HerdrCore(fake.exec);
  expect(await core.status("t9")).toBe("gone");
  fake.fail = "get";
  await expect(core.status("t9")).rejects.toThrow("connection lost");
  expect(await core.shellInForeground("t9")).toBe(true);
});

test("core sends literal text once with hc's combined paste and Enter", async () => {
  const fake = new FakeCore();
  const pane = fake.add();
  const text = "it's $(touch /bad) `id`\nsecond line";
  expect(await new HerdrCore(fake.exec).deliver("t1", text)).toBe(true);
  expect(pane.received).toEqual([text]);
});

test("core rechecks foreground before sending when an agent becomes a shell", async () => {
  const fake = new FakeCore();
  const pane = fake.add();
  let gets = 0;
  fake.beforeGet = () => {
    if (++gets === 2) pane.foreground = { name: "bash", argv: ["bash"] };
  };
  expect(await new HerdrCore(fake.exec).deliver("t1", "unsafe")).toBe(false);
  expect(pane.received).toEqual([]);
});

test.each(["send", "keys"])("core reports uncertain %s without retrying the message", async (verb) => {
  const fake = new FakeCore();
  fake.add();
  fake.fail = verb;
  const core = new HerdrCore(fake.exec);
  const error = await (verb === "send" ? core.deliver("t1", "one message") : core.submitTyped("t1")).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DeliveryUncertain);
  if (!(error instanceof DeliveryUncertain)) throw new Error("expected uncertain delivery");
  expect(error.typed).toBe(verb === "keys");
  expect(fake.calls.filter((call) => call[0] === verb)).toHaveLength(1);
});

test("core submits already typed text with Enter only", async () => {
  const fake = new FakeCore();
  const pane = fake.add();
  expect(await new HerdrCore(fake.exec).submitTyped("t1")).toBe(true);
  expect(pane.received).toEqual(["<enter>"]);
});

test("core shell opt-in requires a positively identified live shell", async () => {
  const fake = new FakeCore();
  const pane = fake.add();
  const core = new HerdrCore(fake.exec);
  expect(await core.typeIntoShell("t1", "echo yes")).toBe(false);
  pane.foreground = { name: "sh", argv: ["sh", "-i"] };
  expect(await core.typeIntoShell("t1", "echo yes")).toBe(true);
  pane.state = "exited";
  expect(await core.typeIntoShell("t1", "echo no")).toBe(false);
  expect(pane.received).toEqual(["echo yes"]);
});

test("core refuses to deliver to exited terminals and closes live ones", async () => {
  const fake = new FakeCore();
  const pane = fake.add();
  const core = new HerdrCore(fake.exec);
  await core.close("t1");
  expect(pane.state).toBe("exited");
  expect(await core.deliver("t1", "never")).toBe(false);
  expect(pane.received).toEqual([]);
});

test("core parses screen text and rejects malformed protocol replies", async () => {
  spaceEnv({});
  const fake = new FakeCore();
  fake.add().screen = "\x1b[32mWorking\x1b[0m";
  expect(await new HerdrCore(fake.exec).read("t1", 12)).toBe("Working");
  const core = new HerdrCore(async (_cmd, argv) => ({ code: 0, stdout: argv[0] === "ls" ? '{"terminals":[]}' : "{}", stderr: "" }));
  await expect(core.read("t1")).rejects.toThrow("no screen text");
  await expect(core.status("t1")).rejects.toThrow("no terminal address");
  await expect(core.createTab("bad", "/tmp")).rejects.toThrow("no local terminal address");
});

test("core up and start launch distinct grouped terminals with the configured agent and environment", async () => {
  const keys = ["DORI_HOME", "DORI_AGENT_CMD", "DORI_TELEMETRY", "HERDR_WORKSPACE_ID", "DORI_HERDR_SPACE", "HC_TERMINAL_ID"];
  const previous = keys.map((key) => process.env[key]);
  const home = mkdtempSync(join(tmpdir(), "dori-core-test-"));
  onTestFinished(() => {
    keys.forEach((key, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    rmSync(home, { recursive: true, force: true });
  });
  Object.assign(process.env, { DORI_HOME: home, DORI_AGENT_CMD: "/custom/omo-claude", DORI_TELEMETRY: "0" });
  for (const key of ["HERDR_WORKSPACE_ID", "DORI_HERDR_SPACE", "HC_TERMINAL_ID"]) delete process.env[key];
  const deps = defaultDeps();
  expect(deps.herdr).toBeInstanceOf(HerdrCore);
  const fake = new FakeCore();
  const core = new HerdrCore(fake.exec);
  const d = { ...deps, herdr: core };
  expect(await main(["up", "--cwd", home], d)).toBe(0);
  expect([...fake.terminals.values()].map((t) => t.labels["where"])).toEqual([
    "dori / dori-lead", "dori / dori-duty", "dori / dori-duty-loop", "dori / dori-hourly-loop",
  ]);
  expect(d.store.roles()).toEqual({ lead: "t1", duty: "t2" });
  const terminals = [...fake.terminals.values()];
  for (const t of terminals) {
    expect(t.cwd).toBe(home);
    expect(t.env).toContain("DORI_TELEMETRY=0");
    expect(t.env).toContain(`DORI_HOME=${home}`);
  }
  expect(new Set(terminals.map((t) => t.name)).size).toBe(4);
  expect(terminals[0]?.commands[0]).toContain("/custom/omo-claude --append-system-prompt");
  expect(terminals[1]?.commands[0]).toContain("/custom/omo-claude --append-system-prompt");
  expect(terminals[2]?.commands[0]).toContain("duty --interval 60");
  expect(terminals[3]?.commands[0]).toContain(" loop");
  const brief = join(home, "task.md");
  writeFileSync(brief, "A small task");
  expect(await main(["start", "core-lane", "--brief", brief, "--cwd", home, "--workspace", "dori"], d)).toBe(0);
  expect(d.store.lane("core-lane")?.paneId).toBe("t5");
  expect(fake.terminals.get("t5")?.env).toContain("DORI_LANE=core-lane");
  expect(fake.terminals.get("t5")?.commands[0]).toContain("/custom/omo-claude");
  expect(resolveTarget(d, "t5")).toBe("t5");
  expect(["t1", "t2", "t3", "t4", "t5"].map((t) => fake.tabName(t))).toEqual([
    "lead", "duty", "duty-loop", "hourly-loop", "core-lane",
  ]);
  await expect(core.run("t5", "another command")).rejects.toThrow("not a fresh launch shell");
});

test("defaultDeps always drives HerdrCore, with no backend switch in the environment", () => {
  spaceEnv({});
  expect(defaultDeps().herdr).toBeInstanceOf(HerdrCore);
});

/** Dori itself may run inside an hc terminal; keep its space settings out of these tests. */
function spaceEnv(env: Record<string, string>): void {
  const keys = ["DORI_HERDR_SPACE", "HC_TERMINAL_ID"];
  const previous = keys.map((key) => process.env[key]);
  onTestFinished(() => keys.forEach((key, index) => {
    const value = previous[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }));
  keys.forEach((key) => delete process.env[key]);
  Object.assign(process.env, env);
}

test("core names the app tab once the window lists the new terminal", async () => {
  spaceEnv({});
  const fake = new FakeCore();
  fake.app = "late";
  const pauses: number[] = [];
  const core = new HerdrCore(fake.exec, "hc", "herdr-app", async (ms) => { pauses.push(ms); });
  const lead = await core.createWorkspace("dori", "/tmp");
  expect(fake.tabName(lead.paneId)).toBe("lead");
  expect(pauses).toHaveLength(1);
});

test.each(["missing", "fail"] as const)("core still launches when herdr-app is %s, leaving the tab unnamed", async (app) => {
  spaceEnv({});
  const fake = new FakeCore();
  fake.app = app;
  const core = new HerdrCore(fake.exec, "hc", "herdr-app", async () => {});
  const lead = await core.createWorkspace("dori", "/tmp");
  await core.run(lead.paneId, "agent");
  expect(fake.terminals.get(lead.paneId)?.commands).toHaveLength(1);
  expect(fake.tabName(lead.paneId)).toBe("1");
});

test("core still launches when no app tab ever holds the terminal", async () => {
  spaceEnv({});
  const fake = new FakeCore();
  const appCalls: string[] = [];
  const lead = await new HerdrCore(async (binary, argv) => {
    if (binary === "herdr-app") {
      appCalls.push(argv[0] ?? "");
      fake.tabs.clear();
    }
    return fake.exec(binary, argv);
  }, "hc", "herdr-app", async () => {}).createWorkspace("dori", "/tmp");
  expect(lead.paneId).toBe("t1");
  expect(appCalls).toEqual(Array(10).fill("ls"));
});

function twoSpacesNamedFormaRs(env: Record<string, string>): FakeCore {
  spaceEnv(env);
  const fake = new FakeCore();
  fake.add("t1").labels = { "herdr.space": "sp-old", where: "forma-rs / 1" };
  fake.add("t2").labels = { "herdr.space": "sp-new", where: "forma-rs / 1" };
  return fake;
}

async function placeAll(fake: FakeCore): Promise<string[]> {
  const core = new HerdrCore(fake.exec);
  const lead = await core.createWorkspace("dori", "/tmp");
  await core.split(lead.paneId, "/tmp");
  // A later process (start, or the hourly loop's lanes) resolves the space anew.
  const lane = await new HerdrCore(fake.exec).createTab("lane", "/tmp", "dori");
  await new HerdrCore(fake.exec).createTab("lane2", "/tmp", lead.workspaceId);
  expect(lane.workspaceId).toBe(lead.workspaceId);
  return [...fake.terminals.entries()].filter(([id]) => id !== "t1" && id !== "t2")
    .map(([, t]) => `${t.labels["herdr.space"]} ${t.labels["where"]}`);
}

test("core places every terminal in DORI_HERDR_SPACE even when another space has the same name", async () => {
  const fake = twoSpacesNamedFormaRs({ DORI_HERDR_SPACE: "sp-new", HC_TERMINAL_ID: "t1" });
  expect(await placeAll(fake)).toEqual([
    "sp-new forma-rs / dori-lead", "sp-new forma-rs / dori-hourly-loop",
    "sp-new forma-rs / dori-lane", "sp-new forma-rs / dori-lane2",
  ]);
  expect(fake.terminals.get("t2")?.received).toEqual([]);
});

test("core places every terminal in the space of the terminal Dori is started from", async () => {
  const fake = twoSpacesNamedFormaRs({ HC_TERMINAL_ID: "t2" });
  expect(await placeAll(fake)).toEqual([
    "sp-new forma-rs / dori-lead", "sp-new forma-rs / dori-hourly-loop",
    "sp-new forma-rs / dori-lane", "sp-new forma-rs / dori-lane2",
  ]);
});

test("core falls back to the first app space without DORI_HERDR_SPACE or HC_TERMINAL_ID", async () => {
  const fake = twoSpacesNamedFormaRs({});
  expect((await placeAll(fake)).every((t) => t.startsWith("sp-old forma-rs / "))).toBe(true);
});

test("core refuses a DORI_HERDR_SPACE no terminal is in", async () => {
  const fake = twoSpacesNamedFormaRs({ DORI_HERDR_SPACE: "sp-missing" });
  await expect(new HerdrCore(fake.exec).createWorkspace("dori", "/tmp")).rejects.toThrow("sp-missing");
});

test("core reuses existing app space labels without typing into its terminals", async () => {
  spaceEnv({});
  const fake = new FakeCore();
  const existing = fake.add();
  existing.labels = { "herdr.space": "sp-existing", where: "work / existing" };
  const core = new HerdrCore(fake.exec);
  const lead = await core.createWorkspace("dori", "/tmp");
  const duty = await core.createTab("duty", "/tmp", lead.workspaceId);
  expect(lead.workspaceId).toBe("sp-existing");
  expect(fake.terminals.get(duty.paneId)?.labels).toEqual({ "herdr.space": "sp-existing", where: "work / dori-duty" });
  expect(existing.commands).toEqual([]);
  expect(existing.received).toEqual([]);
});
