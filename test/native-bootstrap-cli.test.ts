import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const repo = "formaengine/forma-rs";
const origin = `https://github.com/${repo}.git`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(argv: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function executable(path: string, body: string) {
  writeFileSync(path, `#!${process.execPath}\n${body}`);
  chmodSync(path, 0o755);
}

async function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-bootstrap-cli-")));
  roots.push(root);
  const source = join(root, "source");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const workflows = join(source, ".atomic/workflows");
  const sentinel = join(root, "sibling-imported");
  const hostile = join(root, "hostile-imported");
  const execution = join(root, "python-execution.json");
  for (const dir of [bin, home, workflows, join(root, "poison")]) mkdirSync(dir, { recursive: true });
  const python = Bun.which("python3");
  if (!python) throw new Error("CLI sandbox requires a real python3 interpreter");
  symlinkSync(python, join(bin, "python3"));
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: home, DORI_HOME: join(root, "dori"), DORI_TELEMETRY: "0",
    DORI_AGENT_CMD: join(bin, "agent"), DORI_REVIEW_TIMEOUT_MIN: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Sandbox", GIT_AUTHOR_EMAIL: "sandbox@example.invalid",
    GIT_COMMITTER_NAME: "Sandbox", GIT_COMMITTER_EMAIL: "sandbox@example.invalid",
  };
  const remote = join(root, "origin.git");
  writeFileSync(join(root, "gitconfig"), `[url "${remote}"]\n\tinsteadOf = ${origin}\n[url "${root}/blocked/"]\n\tinsteadOf = https://github.com/\n[protocol "file"]\n\tallow = always\n`);
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
  writeFileSync(join(workflows, "caller_sibling.py"), `from pathlib import Path\nPath(${JSON.stringify(sentinel)}).write_text("trusted sibling")\n`);
  const entry = join(workflows, "dori-landing.py");
  writeFileSync(entry, `import argparse, json, sys
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
`);
  writeFileSync(join(workflows, "arbitrary.py"), `from pathlib import Path\nPath(${JSON.stringify(sentinel)}).write_text("arbitrary entry executed")\n`);
  await git("add", ".");
  await git("commit", "-m", "Pin sandbox adapter and sibling");
  const head = await git("rev-parse", "HEAD");
  const tree = await git("rev-parse", "HEAD^{tree}");
  writeFileSync(join(root, "head"), head);
  writeFileSync(join(root, "verdict"), "CLEAR");
  executable(join(bin, "gh"), `
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") console.log(JSON.stringify({headRefOid: readFileSync(${JSON.stringify(join(root, "head"))}, "utf8")}));
else if (args[0] === "pr" && args[1] === "checks") console.log("[]");
else if (args[0] === "pr" && args[1] === "merge") { appendFileSync(${JSON.stringify(join(root, "direct-merge"))}, "merge"); process.exit(92); }
else process.exit(91);
`);
  executable(join(bin, "agent"), `
import { readFileSync } from "node:fs";
console.log("VERDICT: " + readFileSync(${JSON.stringify(join(root, "verdict"))}, "utf8"));
`);
  executable(join(bin, "arbitrary"), `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinel)}, "arbitrary executable ran");
`);
  env["DORI_LANDING_BACKEND"] = JSON.stringify(["python3", entry]);
  env["FORMA_QUEUE_BOOTSTRAP"] = JSON.stringify({ repo, pr: 7, head, tree });
  return { root, source, workflows, sentinel, hostile, execution, entry, env, git, head, tree, base };
}

type Fixture = Awaited<ReturnType<typeof sandbox>>;
const dori = (fx: Fixture, args: string[]) => run([process.execPath, cli, ...args], fx.root, fx.env);
async function reviewed(fx: Fixture) {
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
function refused(fx: Fixture, result: Awaited<ReturnType<typeof dori>>, expected = { code: 2, reason: "MERGE_REFUSED" }) {
  expect(result.code, JSON.stringify(result)).toBe(expected.code);
  expect(result.stderr).toContain(expected.reason);
  expect(result.stdout).not.toMatch(/QUEUED|MERGED/);
  expect(existsSync(fx.sentinel), result.stderr).toBe(false);
  expect(existsSync(fx.execution), result.stderr).toBe(false);
  expect(existsSync(join(fx.root, "direct-merge"))).toBe(false);
}
const tuple = (fx: Fixture, over: Record<string, unknown>) => {
  fx.env["FORMA_QUEUE_BOOTSTRAP"] = JSON.stringify({ repo, pr: 7, head: fx.head, tree: fx.tree, ...over });
};

const invalidSources: readonly [string, (fx: Fixture) => void | Promise<unknown>, { code: number; reason: string }?][] = [
  ["wrong tuple head", (fx) => tuple(fx, { head: fx.base })],
  ["wrong tuple tree", (fx) => tuple(fx, { tree: "b".repeat(40) })],
  ["wrong tuple repo", (fx) => tuple(fx, { repo: "other/repo" })],
  ["wrong tuple PR", (fx) => tuple(fx, { pr: 8 })],
  ["short tuple head", (fx) => tuple(fx, { head: fx.head.slice(0, 12) }), { code: 1, reason: "FORMA_QUEUE_BOOTSTRAP must be JSON exactly" }],
  ["short tuple tree", (fx) => tuple(fx, { tree: fx.tree.slice(0, 12) }), { code: 1, reason: "FORMA_QUEUE_BOOTSTRAP must be JSON exactly" }],
  ["extra bootstrap field", (fx) => tuple(fx, { source: fx.source }), { code: 1, reason: "FORMA_QUEUE_BOOTSTRAP must be JSON exactly" }],
  ["missing bootstrap tuple", (fx) => { delete fx.env["FORMA_QUEUE_BOOTSTRAP"]; }],
  ["missing tuple with absolute Python entry", (fx) => {
    delete fx.env["FORMA_QUEUE_BOOTSTRAP"];
    const python = Bun.which("python3");
    if (!python) throw new Error("CLI sandbox requires python3");
    fx.env["DORI_LANDING_BACKEND"] = JSON.stringify([python, fx.entry]);
  }],
  ["missing tuple with a prefixed adapter", (fx) => {
    delete fx.env["FORMA_QUEUE_BOOTSTRAP"];
    fx.env["DORI_LANDING_BACKEND"] = JSON.stringify(["/usr/bin/env", "python3", fx.entry]);
  }],
  ["source HEAD differs from requested head", (fx) => {
    writeFileSync(join(fx.root, "head"), fx.base);
    tuple(fx, { head: fx.base });
  }],
  ["tracked sibling dirt", (fx) => { appendFileSync(join(fx.workflows, "caller_sibling.py"), "# dirty\n"); }],
  ["untracked sibling", (fx) => { writeFileSync(join(fx.workflows, "new_sibling.py"), "untrusted = True\n"); }],
  ["ignored importable source", (fx) => { writeFileSync(join(fx.workflows, "ignored_module.py"), "untrusted = True\n"); }],
  ["ignored importable extension", (fx) => { writeFileSync(join(fx.workflows, "ignored_module.so"), "untrusted"); }],
  ["ignored real Python cache", async (fx) => {
    const result = await run(["python3", "-I", "-S", "-B", "-c", "import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True)", join(fx.workflows, "caller_sibling.py")], fx.root, fx.env);
    expect(result.code, result.stderr).toBe(0);
  }],
  ["wrong source origin", (fx) => fx.git("remote", "set-url", "origin", "https://github.com/other/repo.git")],
  ["nonancestor fresh main despite stale local tracking ref", async (fx) => {
    const tree = await fx.git("rev-parse", `${fx.base}^{tree}`);
    const fresh = await fx.git("commit-tree", tree, "-p", fx.base, "-m", "Divergent fresh main");
    await fx.git("push", "origin", `${fresh}:refs/heads/main`);
    await fx.git("update-ref", "refs/remotes/origin/main", fx.base);
  }],
  ["arbitrary Python entry", (fx) => { fx.env["DORI_LANDING_BACKEND"] = JSON.stringify(["python3", join(fx.workflows, "arbitrary.py")]); }],
  ["arbitrary executable entry", (fx) => { fx.env["DORI_LANDING_BACKEND"] = JSON.stringify([join(fx.root, "bin/arbitrary")]); }],
];

describe("native caller bootstrap through the real CLI", () => {
  test.each(invalidSources.map(([name, change, expected]) => [name, change, expected ?? { code: 2, reason: "MERGE_REFUSED" }] as const))("refuses %s before imported sibling execution", async (_name, change, expected) => {
    const fx = await sandbox();
    await change(fx);
    await reviewed(fx);

    const result = await dori(fx, ["merge", `${repo}#7`]);

    refused(fx, result, expected);
    expect(result.stderr).toMatch(/bootstrap|source|canonical|backend/i);
  });

  test("clean pinned source executes isolated Python and queues without hostile imports", async () => {
    const fx = await sandbox();
    const poison = join(fx.root, "poison");
    const userSite = await run(["python3", "-c", "import site; print(site.getusersitepackages())"], fx.root, {
      ...fx.env, PYTHONUSERBASE: join(fx.root, "user"),
    });
    expect(userSite.code, userSite.stderr).toBe(0);
    mkdirSync(userSite.stdout.trim(), { recursive: true });
    const attack = `from pathlib import Path\nPath(${JSON.stringify(fx.hostile)}).write_text("hostile import")\nraise RuntimeError("hostile Python root executed")\n`;
    for (const dir of [poison, userSite.stdout.trim()]) {
      for (const name of ["caller_sibling.py", "sitecustomize.py", "usercustomize.py"]) writeFileSync(join(dir, name), attack);
    }
    Object.assign(fx.env, { PYTHONPATH: poison, PYTHONUSERBASE: join(fx.root, "user"), PYTHONHOME: poison });
    await reviewed(fx);

    const result = await dori(fx, ["merge", `${repo}#7`]);

    expect(result).toEqual({ code: 0, stdout: `QUEUED ${repo}#7 head=${fx.head}\n`, stderr: "" });
    expect(readFileSync(fx.sentinel, "utf8")).toBe("trusted sibling");
    expect(JSON.parse(readFileSync(fx.execution, "utf8"))).toEqual({
      isolated: 1, no_site: 1, dont_write_bytecode: 1, ignore_environment: 1, no_user_site: 1,
    });
    expect(existsSync(fx.hostile)).toBe(false);
    expect(existsSync(join(fx.root, "direct-merge"))).toBe(false);
    expect(await fx.git("status", "--porcelain", "--ignored")).toBe("");
  });

  test("native admission without a backend refuses before imports", async () => {
    const fx = await sandbox();
    await reviewed(fx);
    delete fx.env["DORI_LANDING_BACKEND"];

    const result = await dori(fx, ["merge", `${repo}#7`]);

    refused(fx, result);
  });

  test.each(["missing", "BLOCK", "stale"])("requires exact-head CLEAR when review is %s", async (review) => {
    const fx = await sandbox();
    if (review !== "missing") {
      writeFileSync(join(fx.root, "verdict"), review === "BLOCK" ? "BLOCK" : "CLEAR");
      const result = await dori(fx, ["review", `${repo}#7`]);
      expect(result.code, result.stderr).toBe(review === "BLOCK" ? 1 : 0);
      if (review === "stale") writeFileSync(join(fx.root, "head"), fx.base);
    }

    const result = await dori(fx, ["merge", `${repo}#7`]);

    refused(fx, result);
  });
});
