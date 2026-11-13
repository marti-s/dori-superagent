import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultDeps, mergeGate, Refusal, type Deps } from "../src/harness.ts";
import { spawnExec, type Exec } from "../src/terminal.ts";
import { World } from "./fake.ts";

const repo = "formaengine/forma-rs";
const pr = `${repo}#7`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnExec("git", ["-C", cwd, ...args]);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function configured(root: string, backend: readonly string[], pin: string | undefined): Deps {
  const saved = { ...process.env };
  try {
    process.env.DORI_HOME = join(root, "home");
    process.env.DORI_TELEMETRY = "0";
    process.env.LANDING_BACKEND = JSON.stringify(backend);
    if (pin === undefined) delete process.env.FORMA_QUEUE_BOOTSTRAP;
    else process.env.FORMA_QUEUE_BOOTSTRAP = pin;
    return defaultDeps();
  } finally {
    process.env = saved;
  }
}

async function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-bootstrap-")));
  roots.push(root);
  const source = join(root, "source");
  const remote = join(root, "origin.git");
  const script = join(source, ".agents/workflows/landing-verifier.py");
  const marker = join(root, "executed.json");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(join(source, ".gitignore"), "*.pyc\n__pycache__/\nignored/\n");
  // This stand-in adapter uses the same explicit sibling import root as Forma. Its marker proves real execution.
  writeFileSync(script, `import sys, pathlib, json
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
`);
  writeFileSync(join(dirname(script), "sibling.py"), 'VALUE = "trusted sibling"\n');
  mkdirSync(join(source, "specs"));
  writeFileSync(join(source, "specs/checker.py"), 'VALUE = "trusted checker"\n');
  await git(source, "init", "-b", "main");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=Sandbox", "-c", "user.email=sandbox@example.invalid", "commit", "-qm", "source");
  await git(root, "clone", "--bare", source, remote);
  await git(source, "remote", "add", "origin", "https://github.com/formaengine/forma-rs.git");
  const pin = { repo, pr: 7, head: await git(source, "rev-parse", "HEAD"), tree: await git(source, "rev-parse", "HEAD^{tree}") };
  const w = new World();
  const backendCalls: string[] = [];
  let fetchFailure = false;
  const exec: Exec = async (command, argv, options) => {
    if (command === "gh") return { code: 0, stdout: JSON.stringify({ headRefOid: pin.head }), stderr: "" };
    if (command === "git") {
      // Only the network transport is replaced. Fetch, refs, object ancestry, status and tree reads are real Git.
      if (argv.includes("fetch")) {
        if (fetchFailure) return { code: 1, stdout: "", stderr: "offline " + "x".repeat(4000) };
        return spawnExec(command, argv.map((arg) => arg === "origin" ? remote : arg), options);
      }
      return spawnExec(command, argv, options);
    }
    backendCalls.push(command);
    return spawnExec(command, argv, options);
  };
  const deps = (change: Record<string, unknown> = {}, backend: readonly string[] = ["python3", script]) => {
    const d = { ...configured(root, backend, JSON.stringify({ ...pin, ...change })), exec, usage: w.recorder };
    d.store.saveReceipt({ pr, sha: pin.head, verdict: "CLEAR", model: "default", at: 0, summary: "clear" }, "VERDICT: CLEAR");
    return d;
  };
  return { root, source, remote, script, marker, pin, backendCalls, deps, w, failFetch: () => { fetchFailure = true; } };
}

test("dirty pinned source refuses before any interpreter starts", async () => {
  const fx = await sandbox();
  writeFileSync(fx.script, readFileSync(fx.script, "utf8") + "\n# unreviewed change\n");

  await expect(mergeGate(fx.deps(), pr)).rejects.toThrow("source is dirty");
  expect(fx.backendCalls).toEqual([]);
  expect(existsSync(fx.marker)).toBe(false);
});

test("an unpinned clean main source still executes isolated Python", async () => {
  const fx = await sandbox();
  const { formaQueueBootstrap: _pin, ...unpinned } = fx.deps();

  expect(await mergeGate(unpinned, pr)).toBe(`QUEUED ${pr} head=${fx.pin.head}`);
  expect(JSON.parse(readFileSync(fx.marker, "utf8")).isolated).toBe(1);
});

test("an unpinned dirty main source refuses before imports", async () => {
  const fx = await sandbox();
  const { formaQueueBootstrap: _pin, ...unpinned } = fx.deps();
  writeFileSync(fx.script, readFileSync(fx.script, "utf8") + "\n# dirty main source\n");

  await expect(mergeGate(unpinned, pr)).rejects.toThrow("source is dirty");
  expect(fx.backendCalls).toEqual([]);
  expect(existsSync(fx.marker)).toBe(false);
});

test.each([
  ["untracked", "notes.txt", "source is dirty"],
  ["ignored Python", ".agents/workflows/ignored/payload.py", "import artifact"],
  ["ignored bytecode", ".agents/workflows/sibling.pyc", "import artifact"],
  ["ignored optimized bytecode", ".agents/workflows/ignored/payload.pyo", "import artifact"],
  ["ignored shared library", ".agents/workflows/ignored/payload.so", "import artifact"],
  ["ignored Windows library", ".agents/workflows/ignored/payload.pyd", "import artifact"],
  ["ignored import path", ".agents/workflows/ignored/payload.pth", "import artifact"],
  ["ignored cache", ".agents/workflows/__pycache__/sibling.cpython-311.pyc", "import artifact"],
  ["specs ignored Python", "specs/ignored/payload.py", "import artifact"],
  ["specs ignored bytecode", "specs/checker.pyc", "import artifact"],
  ["specs ignored cache", "specs/__pycache__/checker.cpython-311.pyc", "import artifact"],
])("%s source payload refuses without executing it", async (_name, path, reason) => {
  const fx = await sandbox();
  const payload = join(fx.source, path);
  mkdirSync(dirname(payload), { recursive: true });
  writeFileSync(payload, `raise RuntimeError("untrusted import executed")\n`);

  await expect(mergeGate(fx.deps(), pr)).rejects.toThrow(reason);
  expect(fx.backendCalls).toEqual([]);
  expect(existsSync(payload)).toBe(true);
});

test("specs import root symlink refuses before interpreter execution", async () => {
  const fx = await sandbox();
  mkdirSync(join(fx.source, "specs/ignored"));
  symlinkSync(fx.root, join(fx.source, "specs/ignored/escape"));
  await expect(mergeGate(fx.deps(), pr)).rejects.toThrow("symlink");
  expect(fx.backendCalls).toEqual([]);
  expect(existsSync(fx.marker)).toBe(false);
});

test.each([
  ["repository", { repo: "other/repo" }, "request"],
  ["PR", { pr: 8 }, "request"],
  ["head", { head: "b".repeat(40) }, "request"],
  ["tree", { tree: "c".repeat(40) }, "tree"],
])("mismatched pinned %s refuses before interpreter execution", async (_name, change, reason) => {
  const fx = await sandbox();

  await expect(mergeGate(fx.deps(change), pr)).rejects.toThrow(reason);
  expect(fx.backendCalls).toEqual([]);
});

test.each(["wrong origin", "fetch failure", "stale source", "staged source", "source HEAD", "symlink escape", "empty cache"])(
  "%s refuses before interpreter execution",
  async (fault) => {
    const fx = await sandbox();
    let reason = "";
    switch (fault) {
      case "wrong origin":
        await git(fx.source, "remote", "set-url", "origin", "https://github.com/other/repo.git");
        reason = "origin"; break;
      case "fetch failure":
        fx.failFetch(); reason = "offline"; break;
      case "stale source": {
        const next = await git(fx.source, "-c", "user.name=Sandbox", "-c", "user.email=sandbox@example.invalid",
          "commit-tree", fx.pin.tree, "-p", fx.pin.head, "-m", "new remote main");
        await git(fx.source, "push", fx.remote, `${next}:refs/heads/main`);
        reason = "ancestor"; break;
      }
      case "staged source":
        writeFileSync(join(fx.source, "new.txt"), "staged\n");
        await git(fx.source, "add", "new.txt"); reason = "source is dirty"; break;
      case "source HEAD":
        await git(fx.source, "-c", "user.name=Sandbox", "-c", "user.email=sandbox@example.invalid", "commit", "--allow-empty", "-qm", "moved source");
        reason = "HEAD"; break;
      case "symlink escape":
        mkdirSync(join(dirname(fx.script), "ignored"));
        symlinkSync(fx.root, join(dirname(fx.script), "ignored/escape"));
        reason = "symlink"; break;
      case "empty cache":
        mkdirSync(join(dirname(fx.script), "__pycache__"));
        reason = "import artifact"; break;
    }

    const failure: unknown = await mergeGate(fx.deps(), pr).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Refusal);
    expect(failure instanceof Error ? failure.message : "").toContain(reason);
    expect(failure instanceof Error ? failure.message.length : Infinity).toBeLessThan(2400);
    expect(fx.backendCalls).toEqual([]);
  },
);

test.each(["prefix", "alternate script", "relative script", "extra argument", "executable override"])(
  "bootstrap refuses %s backend shape before starting a process",
  async (shape) => {
    const fx = await sandbox();
    const backend = shape === "prefix" ? ["env", "python3", fx.script]
      : shape === "alternate script" ? ["python3", join(dirname(fx.script), "sibling.py")]
      : shape === "relative script" ? ["python3", ".agents/workflows/landing-verifier.py"]
      : shape === "extra argument" ? ["python3", fx.script, "--verify"]
      : ["/arbitrary/python3", fx.script];

    await expect(mergeGate(fx.deps({}, backend), pr)).rejects.toThrow("bootstrap backend");
    expect(fx.backendCalls).toEqual([]);
  },
);

test.each(["", "null", "[]", "{}", "not json", '{"repo":"formaengine/forma-rs","pr":"7","head":"a","tree":"b"}'])(
  "defaultDeps fails closed on malformed bootstrap %j",
  (raw) => {
    const root = mkdtempSync(join(tmpdir(), "dori-bootstrap-config-"));
    roots.push(root);
    expect(() => configured(root, ["python3", "/source/.agents/workflows/landing-verifier.py"], raw)).toThrow(Refusal);
  },
);

test("defaultDeps rejects extra tuple keys", async () => {
  const fx = await sandbox();
  expect(() => fx.deps({ extra: true })).toThrow("FORMA_QUEUE_BOOTSTRAP");
});

test("clean pinned source executes isolated Python and queues without a landing receipt", async () => {
  const fx = await sandbox();
  const d = fx.deps();
  // Configuration has already been restored by configured(); admission must use the snapshot.
  expect(await mergeGate(d, pr)).toBe(`QUEUED ${pr} head=${fx.pin.head}`);
  const observed = JSON.parse(readFileSync(fx.marker, "utf8"));
  expect(observed).toMatchObject({ isolated: 1, no_site: 1, bytecode: true, sibling: "trusted sibling", site_loaded: false });
  expect(observed.path).not.toContain(process.cwd());
  expect(existsSync(join(dirname(fx.script), "__pycache__"))).toBe(false);
  expect(fx.w.usage).toEqual([]);
});
