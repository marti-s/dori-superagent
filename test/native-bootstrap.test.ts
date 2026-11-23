import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mergeGate } from "../src/gate.ts";
import { Refusal } from "../src/refusal.ts";
import { cleanup, configured, git, pr, roots, sandbox } from "./native-bootstrap-setup.ts";

afterEach(cleanup);

test("dirty pinned source refuses before any interpreter starts", async () => {
  const fx = await sandbox();
  writeFileSync(fx.script, `${readFileSync(fx.script, "utf8")}\n# unreviewed change\n`);

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
  writeFileSync(fx.script, `${readFileSync(fx.script, "utf8")}\n# dirty main source\n`);

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

test.each([
  "wrong origin",
  "fetch failure",
  "stale source",
  "staged source",
  "source HEAD",
  "symlink escape",
  "empty cache",
])("%s refuses before interpreter execution", async (fault) => {
  const fx = await sandbox();
  let reason = "";
  switch (fault) {
    case "wrong origin":
      await git(fx.source, "remote", "set-url", "origin", "https://github.com/other/repo.git");
      reason = "origin";
      break;
    case "fetch failure":
      fx.failFetch();
      reason = "offline";
      break;
    case "stale source": {
      const next = await git(
        fx.source,
        "-c",
        "user.name=Sandbox",
        "-c",
        "user.email=sandbox@example.invalid",
        "commit-tree",
        fx.pin.tree,
        "-p",
        fx.pin.head,
        "-m",
        "new remote main",
      );
      await git(fx.source, "push", fx.remote, `${next}:refs/heads/main`);
      reason = "ancestor";
      break;
    }
    case "staged source":
      writeFileSync(join(fx.source, "new.txt"), "staged\n");
      await git(fx.source, "add", "new.txt");
      reason = "source is dirty";
      break;
    case "source HEAD":
      await git(
        fx.source,
        "-c",
        "user.name=Sandbox",
        "-c",
        "user.email=sandbox@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        "moved source",
      );
      reason = "HEAD";
      break;
    case "symlink escape":
      mkdirSync(join(dirname(fx.script), "ignored"));
      symlinkSync(fx.root, join(dirname(fx.script), "ignored/escape"));
      reason = "symlink";
      break;
    case "empty cache":
      mkdirSync(join(dirname(fx.script), "__pycache__"));
      reason = "import artifact";
      break;
  }

  const failure: unknown = await mergeGate(fx.deps(), pr).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Refusal);
  expect(failure instanceof Error ? failure.message : "").toContain(reason);
  expect(failure instanceof Error ? failure.message.length : Infinity).toBeLessThan(2400);
  expect(fx.backendCalls).toEqual([]);
});

test.each(["prefix", "alternate script", "relative script", "extra argument", "executable override"])(
  "bootstrap refuses %s backend shape before starting a process",
  async (shape) => {
    const fx = await sandbox();
    const backend =
      shape === "prefix"
        ? ["env", "python3", fx.script]
        : shape === "alternate script"
          ? ["python3", join(dirname(fx.script), "sibling.py")]
          : shape === "relative script"
            ? ["python3", ".agents/workflows/landing-verifier.py"]
            : shape === "extra argument"
              ? ["python3", fx.script, "--verify"]
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
  expect(observed).toMatchObject({
    isolated: 1,
    no_site: 1,
    bytecode: true,
    sibling: "trusted sibling",
    site_loaded: false,
  });
  expect(observed.path).not.toContain(process.cwd());
  expect(existsSync(join(dirname(fx.script), "__pycache__"))).toBe(false);
  expect(fx.w.usage).toEqual([]);
});
