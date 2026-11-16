import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shq } from "../src/delivery.ts";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const pr = "sandbox/review#9001";
const sha = "a".repeat(40);
const key = `sandbox__review_9001@${sha}`;
const outputs = [
  { name: "clear", stdout: "No findings\nVERDICT: CLEAR\n", agentCode: 0, verdict: "CLEAR", code: 0 },
  { name: "block", stdout: "A finding\nVERDICT: BLOCK\n", agentCode: 0, verdict: "BLOCK", code: 1 },
  { name: "no verdict", stdout: "Partial review\n", agentCode: 0, verdict: undefined, code: 1 },
  { name: "failed verdict", stdout: "VERDICT: CLEAR\n", agentCode: 23, verdict: undefined, code: 1 },
  { name: "failed partial", stdout: "Partial review\n", agentCode: 23, verdict: undefined, code: 1 },
] as const;
const scenarios = outputs.flatMap((output) => [
  { ...output, commandLine: false },
  { ...output, commandLine: true },
]);

test.each(scenarios)("lane CLI $name commandLine=$commandLine preserves the review outcome", async (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "review-command-"));
  try {
    const lane = join(root, "lanes", "ci economy");
    const bin = join(lane, "bin");
    const home = join(root, "home");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home);
    const model = scenario.commandLine ? "fixture/selected-model" : "default";
    const fixed = scenario.commandLine ? ["--lane", "ci economy", "", "owner's choice", "$HOME;$(exit 99)"] : [];
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["pr", "view", "9001", "--repo", "sandbox/review", "--json", "headRefOid"])) {
  console.error("fixture refuses any other gh operation"); process.exit(91);
}
console.log(JSON.stringify({ headRefOid: ${JSON.stringify(sha)} }));
`,
    );
    const agent = join(bin, "reviewer-omo");
    const calls = join(root, "calls");
    writeFileSync(
      agent,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
const fixed = ${JSON.stringify(fixed)};
if (JSON.stringify(argv.splice(0, fixed.length)) !== JSON.stringify(fixed)) {
  console.error("fixture received corrupted fixed arguments"); process.exit(92);
}
const expected = ["-p", "--no-session", ...${JSON.stringify(scenario.commandLine ? ["--model", model] : [])}];
if (JSON.stringify(argv.slice(0, -1)) !== JSON.stringify(expected) || !argv.at(-1)?.includes(${JSON.stringify(sha)})) {
  console.error("fixture received the wrong review mode, model or prompt"); process.exit(93);
}
appendFileSync(${JSON.stringify(calls)}, "called\\n");
process.stdout.write(${JSON.stringify(scenario.stdout)});
if (${scenario.agentCode} !== 0) process.stderr.write("fixture failure\\n");
process.exit(${scenario.agentCode});
`,
    );
    chmodSync(gh, 0o755);
    chmodSync(agent, 0o755);
    const child = Bun.spawn(
      [process.execPath, cli, "review", pr, ...(scenario.commandLine ? ["--model", model] : [])],
      {
        cwd: lane,
        env: {
          PATH: bin,
          HOME: root,
          DORI_HOME: home,
          DORI_TELEMETRY: "0",
          HC_TERMINAL_ID: "lane-fixture",
          DORI_AGENT_CMD: scenario.commandLine ? ["bin/reviewer-omo", ...fixed].map(shq).join(" ") : agent,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(code, stderr).toBe(scenario.code);
    expect(existsSync(calls), stderr).toBe(true);
    expect(readFileSync(calls, "utf8")).toBe("called\n");
    const receipt = join(home, "receipts", `${key}.json`);
    if (scenario.verdict !== undefined) {
      expect(stdout).toBe(`REVIEW ${pr} head=${sha} verdict=${scenario.verdict}\n`);
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({
        pr,
        sha,
        verdict: scenario.verdict,
        model,
        at: expect.any(Number),
        summary: scenario.stdout.trim(),
      });
    } else {
      expect(stdout).toBe("");
      expect(existsSync(receipt)).toBe(false);
      expect(stderr).toContain(scenario.agentCode === 0 ? "no VERDICT line" : "reviewer exited 23");
      if (!scenario.stdout.includes("VERDICT:")) {
        const files = readdirSync(join(home, "receipts"));
        expect(files).toHaveLength(1);
        const file = files[0];
        if (!file) throw new Error("missing review diagnostic");
        expect(file).toEndWith(".noverdict.txt");
        expect(readFileSync(join(home, "receipts", file), "utf8")).toBe(scenario.stdout);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
