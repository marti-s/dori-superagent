import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const pr = "sandbox/review#9001";
const sha = "a".repeat(40);
const key = `sandbox__review_9001@${sha}`;
const scenarios = [
  { name: "empty0", stdout: "", stderr: "", code: 1, attempts: 2 },
  { name: "stderr0", stdout: "", stderr: " \nprovider unavailable\t\n", code: 1, attempts: 2 },
  { name: "validverdict", stdout: "No findings\nVERDICT: CLEAR\n", stderr: "", code: 0, attempts: 1 },
] as const;

function sandbox(scenario: typeof scenarios[number]) {
  const root = mkdtempSync(join(tmpdir(), `dori-review-qa-${scenario.name}-`));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "gh.jsonl"))}, JSON.stringify(argv) + "\\n");
if (JSON.stringify(argv) !== JSON.stringify(["pr", "view", "9001", "--repo", "sandbox/review", "--json", "headRefOid"])) {
  console.error("sandbox refuses any other gh operation"); process.exit(91);
}
console.log(JSON.stringify({ headRefOid: ${JSON.stringify(sha)} }));
`);
  const agent = join(bin, "agent");
  writeFileSync(agent, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const index = argv.indexOf("--session");
const session = index < 0 ? undefined : argv[index + 1];
if (!session || argv.includes("--no-session") || argv.includes("--continue") || argv.includes("--resume")) {
  console.error("sandbox agent requires a fresh durable --session"); process.exit(92);
}
if (existsSync(session)) { console.error("sandbox agent refuses an existing session"); process.exit(93); }
const countPath = ${JSON.stringify(join(root, "agent-count"))};
const invocation = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
writeFileSync(countPath, String(invocation));
const record = {
  source: "sandbox-agent", invocation, session,
  model: argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : "default",
  prompt: argv.at(-1),
};
writeFileSync(session, JSON.stringify(record) + "\\n", { flag: "wx" });
appendFileSync(${JSON.stringify(join(root, "agent.jsonl"))}, JSON.stringify(record) + "\\n");
process.stdout.write(${JSON.stringify(scenario.stdout)});
process.stderr.write(${JSON.stringify(scenario.stderr)});
`);
  chmodSync(gh, 0o755);
  chmodSync(agent, 0o755);
  const env = {
    PATH: bin, HOME: root, DORI_HOME: home, DORI_AGENT_CMD: agent,
    DORI_TELEMETRY: "0", DORI_REVIEW_TIMEOUT_MIN: "1",
  };
  const run = join(root, "run-review");
  writeFileSync(run, `#!${process.execPath}
const child = Bun.spawn(${JSON.stringify([process.execPath, cli, "review", pr])}, {
  env: ${JSON.stringify(env)}, stdin: "ignore", stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
`);
  chmodSync(run, 0o755);
  return { root, home, run };
}

async function invoke(run: string) {
  const child = Bun.spawn([run], {
    env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function artifacts(home: string) {
  const directory = join(home, "receipts", `${key}.attempts`);
  return readdirSync(directory).sort().map((name) => {
    expect(name).toMatch(/^attempt-[A-Za-z0-9]{6}$/);
    const path = join(directory, name);
    const result: {
      pr: string; sha: string; attempt: number; model: string; session: string;
      startedAt: number; finishedAt: number; code: number; timedOut: boolean;
    } = JSON.parse(readFileSync(join(path, "result.json"), "utf8"));
    const session: {
      source: string; invocation: number; session: string; model: string; prompt: string;
    } = JSON.parse(readFileSync(join(path, "session.jsonl"), "utf8"));
    return { path, result, session, stdout: readFileSync(join(path, "stdout"), "utf8"), stderr: readFileSync(join(path, "stderr"), "utf8") };
  });
}

test.each(scenarios)("real CLI $name retains streams and agent-written sessions across repeated invocations", async (scenario) => {
  const fixture = sandbox(scenario);
  try {
    const first = await invoke(fixture.run);
    const kept = artifacts(fixture.home);

    expect(first.code).toBe(scenario.code);
    expect(kept).toHaveLength(scenario.attempts);
    for (const artifact of kept) {
      expect(artifact.stdout).toBe(scenario.stdout);
      expect(artifact.stderr).toBe(scenario.stderr);
      expect(artifact.result).toEqual({
        pr, sha, attempt: artifact.session.invocation, model: "default", session: join(artifact.path, "session.jsonl"),
        startedAt: expect.any(Number), finishedAt: expect.any(Number), code: 0, timedOut: false,
      });
      expect(Number.isFinite(artifact.result.startedAt)).toBe(true);
      expect(artifact.result.finishedAt).toBeGreaterThanOrEqual(artifact.result.startedAt);
      expect(artifact.session).toEqual({
        source: "sandbox-agent", invocation: artifact.result.attempt, session: artifact.result.session,
        model: "default", prompt: expect.stringContaining(`exactly head ${sha}`),
      });
      expect(artifact.session.prompt).toContain(pr);
      expect(first.stderr).toContain(join(artifact.path, "result.json"));
    }
    const receipt = join(fixture.home, "receipts", `${key}.json`);
    if (scenario.code === 0) {
      expect(first.stdout).toBe(`REVIEW ${pr} head=${sha} verdict=CLEAR review=${join(fixture.home, "receipts", `${key}.md`)}\n`);
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({
        pr, sha, verdict: "CLEAR", model: "default", at: expect.any(Number),
        summary: scenario.stdout.trim(), review: join(fixture.home, "receipts", `${key}.md`),
      });
      expect(readFileSync(join(fixture.home, "receipts", `${key}.md`), "utf8")).toBe(scenario.stdout);
    } else {
      expect(first.stdout).toBe("");
      expect(first.stderr).toContain("no VERDICT line twice; no receipt written");
      expect(existsSync(receipt)).toBe(false);
    }
    const preserved = kept.map((a) => ({
      path: a.path, files: readdirSync(a.path).sort().map((name) => [name, readFileSync(join(a.path, name), "utf8")]),
    }));

    const second = await invoke(fixture.run);

    expect(second.code).toBe(scenario.code);
    const all = artifacts(fixture.home);
    expect(all).toHaveLength(scenario.attempts * 2);
    expect(new Set(all.map((a) => a.result.session)).size).toBe(scenario.attempts * 2);
    expect(all.map((a) => a.result.attempt).sort()).toEqual(
      scenario.attempts === 1 ? [1, 1] : [1, 1, 2, 2],
    );
    expect(all.map((a) => a.session.invocation).sort()).toEqual(
      scenario.attempts === 1 ? [1, 2] : [1, 2, 3, 4],
    );
    for (const saved of preserved) {
      expect(readdirSync(saved.path).sort().map((name) => [name, readFileSync(join(saved.path, name), "utf8")])).toEqual(saved.files);
    }
    expect(readFileSync(join(fixture.root, "gh.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    console.log(`CLI_QA ${scenario.name}: exits=${first.code},${second.code} attempts=${all.length} fixture=${fixture.root} run=${fixture.run}`);
  } finally {
    if (process.env["DORI_REVIEW_QA_KEEP"] !== "1") rmSync(fixture.root, { recursive: true, force: true });
    else console.log(`CLI_QA retained fixture=${fixture.root}`);
  }
});
