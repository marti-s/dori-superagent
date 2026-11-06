import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { shq } from "../src/terminal.ts";

// Real hc (herdr-core), one isolated core per test, fake agent instead of a model: proves the terminal plumbing end to end.
// Each core has its own HC_SESSION and scratch XDG paths, so it never sees the user's core or its terminals.
const hcPath = join(homedir(), ".local", "bin", "hc");
const hcBin = existsSync(hcPath) ? hcPath : undefined;
const cli = resolve(import.meta.dir, "../src/cli.ts");
const fake = resolve(import.meta.dir, "fixtures/fake-agent.sh");
const bun = process.execPath;

type Core = { readonly root: string; readonly home: string; readonly env: Record<string, string> };
const cores: Core[] = [];

// The caller's own hc, herdr and dori placement must not leak into the isolated runs.
const leaked = ["HC_SESSION", "HC_SOCKET", "HC_TERMINAL_ID", "DORI_HERDR_SPACE", "HERDR_WORKSPACE_ID"];
const baseEnv = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] =>
  e[1] !== undefined && !leaked.includes(e[0]) && !e[0].startsWith("XDG_")));

const run = async (env: Record<string, string>, bin: string, argv: string[]) => {
  const p = Bun.spawn([bin, ...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
};
const hc = async (core: Core, ...argv: string[]) => {
  const r = await run(core.env, hcPath, argv);
  if (r.code !== 0) throw new Error(`hc ${argv.join(" ")} -> ${r.code}: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const dori = async (core: Core, ...argv: string[]) => {
  const r = await run(core.env, bun, [cli, ...argv]);
  if (r.code !== 0) throw new Error(`dori ${argv.join(" ")} -> ${r.code}: ${r.stderr}`);
  return r.stdout;
};

/** A fresh core under a short /tmp root (the socket path must stay short) with its own dori home. */
const isolatedCore = async (tag: string): Promise<Core> => {
  const root = mkdtempSync("/tmp/dori-e2e-");
  const xdg = Object.fromEntries(["STATE", "CONFIG", "RUNTIME", "DATA", "CACHE"].map((k) =>
    [`XDG_${k}_${k === "RUNTIME" ? "DIR" : "HOME"}`, join(root, k.toLowerCase())]));
  for (const dir of Object.values(xdg)) mkdirSync(dir, { recursive: true });
  const home = join(root, "dori");
  mkdirSync(home);
  const env = {
    ...baseEnv, ...xdg, HC_SESSION: `dori-e2e-${process.pid}-${tag}`,
    DORI_HOME: home, DORI_TELEMETRY: "0",
    // A missing herdr-app: tab renames fail, are logged and never reach the user's Herdr window.
    DORI_HERDR_APP: join(root, "no-herdr-app"),
  };
  const core = { root, home, env };
  cores.push(core);
  await hc(core, "server", "start", "--json");
  return core;
};

const realTerminals = async () => {
  const r = await run(baseEnv, hcPath, ["ls", "--json"]);
  if (r.code !== 0) throw new Error(`real hc ls -> ${r.code}: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { terminals: { address: string; cwd?: string; name?: string }[] }).terminals;
};
const realBefore = hcBin ? await realTerminals() : [];

afterAll(async () => {
  if (!hcBin) return;
  for (const core of cores) {
    // Never `hc server status` here: it would start the core again.
    const listed = JSON.parse(await hc(core, "ls", "--json")) as { terminals: { address: string }[] };
    for (const t of listed.terminals) await run(core.env, hcPath, ["kill", t.address]);
    await hc(core, "server", "stop", "--json");
    rmSync(core.root, { recursive: true, force: true });
  }
  const stray = (await realTerminals()).filter((t) =>
    cores.some((c) => t.cwd?.includes(c.root) || t.cwd?.includes(c.root.replace(/^\/tmp\//, "/private/tmp/"))));
  expect(stray).toEqual([]);
  process.stderr.write(`e2e: real hc terminals before=${realBefore.length} after=${(await realTerminals()).length}\n`);
});

const until = async <T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined) return v;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};
// The lead here is `cat`, which hc reports no agent status for: a bare program terminal. Messages for it must stay in its
// inbox and never be typed into it (#66).
const leadInbox = (core: Core, lead: string) => Bun.file(join(core.home, "inbox", `${lead.replaceAll(":", "_")}.jsonl`)).text();
const leadScreen = (core: Core, lead: string) => hc(core, "read", lead, "--lines", "80");
const startLead = async (core: Core, name: string) => {
  const started = JSON.parse(await hc(core, "run", "--bg", "--json", "--no-parent", "--name", name, "--cwd", core.home, "--", "cat"));
  const lead = started.address as string;
  await dori(core, "role", "lead", lead);
  return lead;
};
// The fake agent runs inside a core terminal, which gets the login environment rather than ours: name the core explicitly.
const doriCmdFor = (core: Core) =>
  `env ${["HC_SESSION", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_CACHE_HOME", "DORI_HOME", "DORI_TELEMETRY", "DORI_HERDR_APP"]
    .map((k) => `${k}=${shq(core.env[k] ?? "")}`).join(" ")} ${shq(bun)} ${shq(cli)}`;

test.skipIf(!hcBin)("a lane started in real hc reports and finishes; the lead terminal has no agent, so both wait in its inbox", async () => {
  const core = await isolatedCore("lane");
  const lead = await startLead(core, "e2e-lead");
  const brief = join(core.home, "brief.md");
  writeFileSync(brief, "E2E-BRIEF say hello\n");

  const doriCmd = doriCmdFor(core);
  const started = Bun.spawn([bun, cli, "start", "e2e-lane", "--brief", brief, "--workspace", "e2e"], {
    env: { ...core.env, DORI_AGENT_CMD: `DORI_E2E_CMD=${shq(doriCmd)} ${shq(fake)}`, DORI_CMD: doriCmd },
    stdout: "pipe", stderr: "pipe",
  });
  expect(await started.exited).toBe(0);

  const leadText = await until("READY in the lead inbox", async () => {
    const text = await leadInbox(core, lead);
    return text.includes("[READY e2e-lane]") ? text : undefined;
  });
  expect(await leadScreen(core, lead)).not.toContain("e2e-lane");
  expect(leadText).toContain("[START e2e-lane]");
  expect(leadText).toContain("[REPORT e2e-lane] read brief: E2E-BRIEF say hello");
  expect(leadText).toContain("[READY e2e-lane] e2e lane finished");
  expect(await dori(core, "status")).toMatch(/e2e-lane\s+ready/);
  expect(await dori(core, "done", "e2e-lane")).toContain("DONE e2e-lane");
}, 60_000);

test.skipIf(!hcBin)("the hourly loop starts a backlog item as a lane in real hc and reports the run to the lead", async () => {
  const core = await isolatedCore("loop");
  const lead = await startLead(core, "e2e-loop-lead");
  const brief = join(core.home, "loop-brief.md");
  writeFileSync(brief, "E2E-LOOP-BRIEF\n");
  expect(await dori(core, "backlog", "add", "loop-item", "--brief", brief, "--cwd", core.home, "--priority", "2")).toContain("ADDED loop-item p2");

  const doriCmd = doriCmdFor(core);
  const loop = Bun.spawn([bun, cli, "loop", "--once", "--max-lanes", "5", "--max-load", "100000"], {
    env: { ...core.env, HERDR_WORKSPACE_ID: "e2e-loop", DORI_AGENT_CMD: `DORI_E2E_CMD=${shq(doriCmd)} ${shq(fake)}`, DORI_CMD: doriCmd },
    stdout: "pipe", stderr: "pipe",
  });
  expect(await loop.exited).toBe(0);
  expect(await new Response(loop.stdout).text()).toContain("LOOP started=1");

  const leadText = await until("READY from the loop-started lane in the lead inbox", async () => {
    const text = await leadInbox(core, lead);
    return text.includes("[READY loop-item]") ? text : undefined;
  });
  expect(await leadScreen(core, lead)).not.toContain("loop-item");
  expect(leadText).toContain("[START loop-item]");
  expect(leadText).toContain("[LOOP ");
  expect(leadText).toContain("started: loop-item (p2)");
  expect(await dori(core, "backlog", "list")).toMatch(/loop-item\s+running/);
  expect(await dori(core, "loop", "status")).toContain("started: loop-item (p2)");
  expect(await dori(core, "loop", "stop", "--text", "e2e pause")).toContain("LOOP STOPPED");
  expect(await dori(core, "loop", "--once")).toContain("LOOP skipped: stopped: e2e pause");
  expect(await dori(core, "done", "loop-item")).toContain("DONE loop-item");
}, 60_000);
