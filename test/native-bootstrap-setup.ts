import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultDeps, type Deps } from "../src/harness.ts";
import { type Exec, spawnExec } from "../src/runtime/exec.ts";
import { World } from "./fake.ts";

export const repo = "formaengine/forma-rs";
export const pr = `${repo}#7`;
export const roots: string[] = [];
/** Removes every sandbox made so far; each test file registers it with afterEach. */
export const cleanup = (): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
};

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnExec("git", ["-C", cwd, ...args]);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

export function configured(root: string, backend: readonly string[], pin: string | undefined): Deps {
  const saved = { ...process.env };
  try {
    process.env["DORI_HOME"] = join(root, "home");
    process.env["DORI_TELEMETRY"] = "0";
    process.env["LANDING_BACKEND"] = JSON.stringify(backend);
    if (pin === undefined) delete process.env["FORMA_QUEUE_BOOTSTRAP"];
    else process.env["FORMA_QUEUE_BOOTSTRAP"] = pin;
    return defaultDeps();
  } finally {
    process.env = saved;
  }
}

export async function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-bootstrap-")));
  roots.push(root);
  const source = join(root, "source");
  const remote = join(root, "origin.git");
  const script = join(source, ".agents/workflows/landing-verifier.py");
  const marker = join(root, "executed.json");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(join(source, ".gitignore"), "*.pyc\n__pycache__/\nignored/\n");
  // This stand-in adapter uses the same explicit sibling import root as Forma. Its marker proves real execution.
  writeFileSync(
    script,
    `import sys, pathlib, json
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sibling
pathlib.Path(${JSON.stringify(marker)}).write_text(json.dumps({
    "isolated": sys.flags.isolated, "no_site": sys.flags.no_site,
    "bytecode": sys.dont_write_bytecode, "sibling": sibling.VALUE,
    "path": sys.path, "site_loaded": "site" in sys.modules
}))
args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
print(json.dumps({"status": "queued", "repo": args["--repo"], "pr": int(args["--pr"]), "expectedHead": args["--expected-head"]}))
`,
  );
  writeFileSync(join(dirname(script), "sibling.py"), 'VALUE = "trusted sibling"\n');
  mkdirSync(join(source, "specs"));
  writeFileSync(join(source, "specs/checker.py"), 'VALUE = "trusted checker"\n');
  await git(source, "init", "-b", "main");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=Sandbox", "-c", "user.email=sandbox@example.invalid", "commit", "-qm", "source");
  await git(root, "clone", "--bare", source, remote);
  await git(source, "remote", "add", "origin", "https://github.com/formaengine/forma-rs.git");
  const pin = {
    repo,
    pr: 7,
    head: await git(source, "rev-parse", "HEAD"),
    tree: await git(source, "rev-parse", "HEAD^{tree}"),
  };
  const w = new World();
  const backendCalls: string[] = [];
  let fetchFailure = false;
  const exec: Exec = async (command, argv, options) => {
    if (command === "gh") return { code: 0, stdout: JSON.stringify({ headRefOid: pin.head }), stderr: "" };
    if (command === "git") {
      // Only the network transport is replaced. Fetch, refs, object ancestry, status and tree reads are real Git.
      if (argv.includes("fetch")) {
        if (fetchFailure) return { code: 1, stdout: "", stderr: `offline ${"x".repeat(4000)}` };
        return spawnExec(
          command,
          argv.map((arg) => (arg === "origin" ? remote : arg)),
          options,
        );
      }
      return spawnExec(command, argv, options);
    }
    backendCalls.push(command);
    return spawnExec(command, argv, options);
  };
  const deps = (change: Record<string, unknown> = {}, backend: readonly string[] = ["python3", script]) => {
    const d = { ...configured(root, backend, JSON.stringify({ ...pin, ...change })), exec, usage: w.recorder };
    d.store.saveReceipt(
      { pr, sha: pin.head, verdict: "CLEAR", model: "default", at: 0, summary: "clear" },
      "VERDICT: CLEAR",
    );
    return d;
  };
  return {
    root,
    source,
    remote,
    script,
    marker,
    pin,
    backendCalls,
    deps,
    w,
    failFetch: () => {
      fetchFailure = true;
    },
  };
}
