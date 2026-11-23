import { expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const cli = resolve(import.meta.dir, "../src/cli.ts");
export const repo = "formaengine/forma-rs";
export const origin = `https://github.com/${repo}.git`;
const roots: string[] = [];
/** Removes every sandbox made so far; each test file registers it with afterEach. */
export const cleanup = (): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
};

export async function run(argv: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

export function executable(path: string, body: string) {
  writeFileSync(path, `#!${process.execPath}\n${body}`);
  chmodSync(path, 0o755);
}

export async function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-bootstrap-cli-")));
  roots.push(root);
  const source = join(root, "source");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const workflows = join(source, ".agents/workflows");
  const sentinel = join(root, "sibling-imported");
  const hostile = join(root, "hostile-imported");
  const execution = join(root, "python-execution.json");
  for (const dir of [bin, home, workflows, join(root, "poison")]) mkdirSync(dir, { recursive: true });
  const python = Bun.which("python3");
  if (!python) throw new Error("CLI sandbox requires a real python3 interpreter");
  symlinkSync(python, join(bin, "python3"));
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    DORI_HOME: join(root, "dori"),
    DORI_TELEMETRY: "0",
    DORI_AGENT_CMD: join(bin, "agent"),
    DORI_REVIEW_TIMEOUT_MIN: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Sandbox",
    GIT_AUTHOR_EMAIL: "sandbox@example.invalid",
    GIT_COMMITTER_NAME: "Sandbox",
    GIT_COMMITTER_EMAIL: "sandbox@example.invalid",
  };
  const remote = join(root, "origin.git");
  writeFileSync(
    join(root, "gitconfig"),
    `[url "${remote}"]\n\tinsteadOf = ${origin}\n[url "${root}/blocked/"]\n\tinsteadOf = https://github.com/\n[protocol "file"]\n\tallow = always\n`,
  );
  const git = async (...args: string[]) => {
    const result = await run(["/usr/bin/git", ...args], source, env);
    expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(0);
    return result.stdout.trim();
  };
  await git("init", "--bare", remote);
  await git("init", "-b", "main");
  writeFileSync(join(source, ".gitignore"), "__pycache__/\n*.pyc\nignored*.py\nignored*.so\n");
  await git("add", ".");
  await git("commit", "-m", "Sandbox base");
  const base = await git("rev-parse", "HEAD");
  await git("remote", "add", "origin", origin);
  await git("push", "origin", "main");
  await git("checkout", "-b", "candidate");
  writeFileSync(
    join(workflows, "caller_sibling.py"),
    `from pathlib import Path\nPath(${JSON.stringify(sentinel)}).write_text("trusted sibling")\n`,
  );
  const entry = join(workflows, "landing-verifier.py");
  writeFileSync(
    entry,
    `import argparse, json, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import caller_sibling
flags = {name: getattr(sys.flags, name) for name in ("isolated", "no_site", "dont_write_bytecode", "ignore_environment", "no_user_site")}
Path(${JSON.stringify(execution)}).write_text(json.dumps(flags))
if any(value != 1 for value in flags.values()):
    raise SystemExit("Python isolation missing")
parser = argparse.ArgumentParser()
parser.add_argument("--repo", required=True)
parser.add_argument("--pr", required=True, type=int)
parser.add_argument("--expected-head", required=True)
args = parser.parse_args()
print(json.dumps({"repo": args.repo, "pr": args.pr, "expectedHead": args.expected_head, "status": "queued"}))
`,
  );
  writeFileSync(
    join(workflows, "arbitrary.py"),
    `from pathlib import Path\nPath(${JSON.stringify(sentinel)}).write_text("arbitrary entry executed")\n`,
  );
  await git("add", ".");
  await git("commit", "-m", "Pin sandbox adapter and sibling");
  const head = await git("rev-parse", "HEAD");
  const tree = await git("rev-parse", "HEAD^{tree}");
  writeFileSync(join(root, "head"), head);
  writeFileSync(join(root, "verdict"), "CLEAR");
  executable(
    join(bin, "gh"),
    `
import { appendFileSync, readFileSync } from "node:fs";
export const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") console.log(JSON.stringify({headRefOid: readFileSync(${JSON.stringify(join(root, "head"))}, "utf8")}));
else if (args[0] === "pr" && args[1] === "checks") console.log("[]");
else if (args[0] === "pr" && args[1] === "merge") { appendFileSync(${JSON.stringify(join(root, "direct-merge"))}, "merge"); process.exit(92); }
else process.exit(91);
`,
  );
  executable(
    join(bin, "agent"),
    `
import { readFileSync } from "node:fs";
console.log("VERDICT: " + readFileSync(${JSON.stringify(join(root, "verdict"))}, "utf8"));
`,
  );
  executable(
    join(bin, "arbitrary"),
    `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinel)}, "arbitrary executable ran");
`,
  );
  env["LANDING_BACKEND"] = JSON.stringify(["python3", entry]);
  env["FORMA_QUEUE_BOOTSTRAP"] = JSON.stringify({ repo, pr: 7, head, tree });
  return { root, source, workflows, sentinel, hostile, execution, entry, env, git, head, tree, base };
}

export type Fixture = Awaited<ReturnType<typeof sandbox>>;
export const dori = (fx: Fixture, args: string[]) => run([process.execPath, cli, ...args], fx.source, fx.env);
export async function reviewed(fx: Fixture) {
  const pin = fx.env["FORMA_QUEUE_BOOTSTRAP"];
  delete fx.env["FORMA_QUEUE_BOOTSTRAP"];
  try {
    const result = await dori(fx, ["review", `${repo}#7`]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("verdict=CLEAR");
  } finally {
    if (pin !== undefined) fx.env["FORMA_QUEUE_BOOTSTRAP"] = pin;
  }
}
export function refused(
  fx: Fixture,
  result: Awaited<ReturnType<typeof dori>>,
  expected = { code: 2, reason: "MERGE_REFUSED" },
) {
  expect(result.code, JSON.stringify(result)).toBe(expected.code);
  expect(result.stderr).toContain(expected.reason);
  expect(result.stdout).not.toMatch(/QUEUED|MERGED/);
  expect(existsSync(fx.sentinel), result.stderr).toBe(false);
  expect(existsSync(fx.execution), result.stderr).toBe(false);
  expect(existsSync(join(fx.root, "direct-merge"))).toBe(false);
}
export const tuple = (fx: Fixture, over: Record<string, unknown>) => {
  fx.env["FORMA_QUEUE_BOOTSTRAP"] = JSON.stringify({ repo, pr: 7, head: fx.head, tree: fx.tree, ...over });
};
