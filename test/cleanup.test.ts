import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { cleanupMergedPr } from "../src/cleanup.ts";
import { HerdrCore } from "../src/herdr-core.ts";
import { done, dutyTick, mergeGate, parsePr } from "../src/harness.ts";
import { backlogAdd, loopTick } from "../src/loop.ts";
import type { Exec, ExecResult } from "../src/terminal.ts";
import { World } from "./fake.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const run: Exec = async (cmd, argv) => {
  const child = Bun.spawn([cmd, ...argv], {
    env: { ...process.env, GIT_MASTER: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

async function fixture(squash: boolean, repository = "marti-s/cleanup-fixture") {
  const root = mkdtempSync(join(tmpdir(), "dori-cleanup-"));
  roots.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(repo);
  const git = async (...args: string[]) => {
    const result = await run("git", ["-C", repo, ...args]);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  await git("init", "-b", "main");
  await git("config", "user.name", "Cleanup Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("config", "core.hooksPath", "/dev/null");
  writeFileSync(join(repo, "base"), "base\n");
  await git("add", ".");
  await git("commit", "-m", "base");
  await git("init", "--bare", remote);
  await git("remote", "add", "origin", remote);
  await git("checkout", "-b", "topic");
  writeFileSync(join(repo, "topic"), "landed content\n");
  await git("add", ".");
  await git("commit", "-m", "topic");
  const head = await git("rev-parse", "HEAD");
  await git("checkout", "main");
  await git("merge", squash ? "--squash" : "--no-ff", "topic", ...(squash ? [] : ["-m", "merge topic"]));
  if (squash) await git("commit", "-m", "squash topic");
  const merged = await git("rev-parse", "HEAD");
  await git("push", "origin", "main", "topic");
  const w = new World();
  // Mutable fixture configuration; production Deps remains readonly.
  const d = { ...w.deps() };
  let terminals: unknown = [];
  d.herdr = new HerdrCore(async (cmd, argv, opts) =>
    cmd === "hc" && argv[0] === "ls"
      ? { code: 0, stdout: JSON.stringify({ terminals }), stderr: "" }
      : w.exec(cmd, argv, opts), "hc", "herdr-app", async () => {}, {});
  const id = `${repository}#7`;
  d.store.saveLane({
    key: "finished", paneId: "gone", tabId: "gone", cwd: repo, brief: "", status: "done",
    createdAt: 0, lastActivityAt: 0, nudges: 0, retiredAt: 1, log: [],
  });
  d.store.saveReceipt({ pr: id, sha: head, verdict: "CLEAR", model: "fixture", at: 0, summary: "clear" }, "clear");
  const api = {
    number: 7, state: "closed", merged: true, merged_at: "2026-11-07T00:00:00Z", merge_commit_sha: merged,
    head: { ref: "topic", sha: head, repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } },
  };
  const open: unknown[][] = [[]];
  let intercept: ((cmd: string, argv: readonly string[]) => Promise<ExecResult | undefined>) | undefined;
  d.exec = async (cmd, argv) => {
    if (cmd === "git" && (argv[0] !== "-C" || !argv[1] || !existsSync(argv[1]) ||
        !realpathSync(argv[1]).startsWith(realpathSync(root) + "/"))) {
      return { code: 128, stdout: "", stderr: "not a fixture repository" };
    }
    const intercepted = await intercept?.(cmd, argv);
    if (intercepted) return intercepted;
    if (cmd === "gh") {
      let value: unknown;
      if (argv[0] === "pr" && argv[1] === "view") value = { headRefOid: head, state: api.merged ? "MERGED" : "OPEN" };
      else if (argv[0] === "pr" && argv[1] === "checks") value = [{ name: "test", bucket: "pass" }];
      else if (argv[0] === "pr" && argv[1] === "merge") return { code: 0, stdout: "", stderr: "" };
      else if (argv[0] === "api") value = argv.some((a) => a.includes("/pulls?")) ? open : api;
      else throw new Error(`unexpected gh ${argv.join(" ")}`);
      return { code: 0, stdout: JSON.stringify(value), stderr: "" };
    }
    // Only the GitHub identity lookup is faked. All ref checks, fetches, and deletions use real Git and a private bare remote.
    if (cmd === "git" && argv.includes("get-url")) {
      return { code: 0, stdout: `https://github.com/${repository}.git\n`, stderr: "" };
    }
    if (cmd === "lsof") return { code: 0, stdout: "p1\nn/outside-the-fixture\n", stderr: "" };
    return run(cmd, argv);
  };
  return {
    root, repo, remote, d, w, id, head, api, open, git,
    intercept(fn: NonNullable<typeof intercept>) { intercept = fn; },
    terminals(value: unknown) { terminals = value; },
    local: () => run("git", ["-C", repo, "show-ref", "--verify", "--quiet", "refs/heads/topic"]),
    remoteRef: () => git("ls-remote", "--heads", "origin", "refs/heads/topic"),
  };
}

test.each([false, true])("confirmed merged source refs are removed after landing (squash=%s)", async (squash) => {
  const f = await fixture(squash);
  const outcome = await mergeGate(f.d, f.id);
  expect(outcome).toStartWith("MERGED ");
  expect((await f.local()).code).toBe(1);
  expect(await f.remoteRef()).toBe("");
}, 30_000);

test("automatic merge cleanup defers to the one-off barrier while explicit cleanup remains available", async () => {
  const f = await fixture(false);
  f.d.store.setStop(0, "one-off cleanup owned by executor", "duty");
  expect(await mergeGate(f.d, f.id)).toStartWith("MERGED ");
  expect((await f.local()).code).toBe(0);
  expect(await f.remoteRef()).not.toBe("");
  expect(f.d.store.cleanups()[0]?.status).toBe("pending");
  expect(await main(["cleanup", f.id], f.d)).toBe(0);
  expect((await f.local()).code).toBe(1);
  expect(await f.remoteRef()).toBe("");
}, 30_000);

async function retirable(f: Awaited<ReturnType<typeof fixture>>) {
  const path = join(f.root, "retired-lane");
  await f.git("worktree", "add", path, "topic");
  const lane = f.d.store.lane("finished");
  if (!lane) throw new Error("missing fixture lane");
  f.d.store.saveLane({
    ...lane, cwd: path,
    final: { text: "merged work complete", at: 1, evidence: [`https://github.com/${f.api.head.repo.full_name}/pull/7`] },
  });
  return { path, argv: ["cleanup", f.id, "--retire-worktree", path, "--owner", "finished", "--expected-head", f.head] };
}

test("explicit owner-approved retirement removes the clean inactive worktree before its merged refs", async () => {
  const f = await fixture(true);
  const retirement = await retirable(f);
  expect(await main(retirement.argv, f.d)).toBe(0);
  expect(await Bun.file(join(retirement.path, ".git")).exists()).toBe(false);
  expect((await f.local()).code).toBe(1);
  expect(await f.remoteRef()).toBe("");
  expect(f.d.store.cleanups()[0]?.worktrees?.[0]?.removedAt).toBeDefined();
  expect(await main(retirement.argv, f.d)).toBe(0);
  expect((await f.local()).code).toBe(1);
}, 30_000);

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Retirement = Awaited<ReturnType<typeof retirable>>;

test.each(["queued", "hourly", "done", "slash"])("automatic Forma cleanup waits for merge and retired ownership through %s", async (entry) => {
  const f = await fixture(false, "formaengine/forma-rs");
  const r = await retirable(f);
  const owner = f.d.store.lane("finished");
  if (!owner) throw new Error("missing fixture owner");
  f.d.store.saveLane({
    ...owner, status: "ready", retiredAt: undefined,
    final: entry === "slash" && owner.final
      ? { ...owner.final, evidence: owner.final.evidence.map((link) => `${link}/`) }
      : owner.final,
  });
  f.api.merged = false;
  if (entry === "queued") {
    f.d.landingBackend = ["fixture-queue"];
    f.intercept(async (cmd) => cmd === "fixture-queue" ? {
      code: 0, stderr: "",
      stdout: JSON.stringify({ repo: "formaengine/forma-rs", pr: 7, expectedHead: f.head, status: "queued" }),
    } : undefined);
    expect(await mergeGate(f.d, f.id)).toStartWith("QUEUED ");
    await dutyTick(f.d);
    expect(existsSync(r.path)).toBe(true);
    expect((await f.local()).code).toBe(0);
    expect(await f.remoteRef()).not.toBe("");
  }
  f.api.merged = true;
  if (entry === "hourly") {
    const brief = join(f.root, "brief.md");
    writeFileSync(brief, "Complete the publishing phase.");
    const item = backlogAdd(f.d, "finished", brief, { cwd: r.path });
    f.d.store.saveItem({ ...item, status: "running" });
    await loopTick(f.d, { force: true, maxStarts: 0 });
  }
  if (entry !== "done") {
    await dutyTick(f.d);
    expect(existsSync(r.path)).toBe(true);
    expect((await f.local()).code).toBe(0);
  }
  if (entry === "done") expect(await main(["done", "finished"], f.d)).toBe(0);
  else await done(f.d, "finished");
  f.w.clock += f.d.tabCloseDelayMs;
  if (entry === "done") expect(await main(["duty", "--once"], f.d)).toBe(0);
  else await dutyTick(f.d);
  expect(existsSync(r.path)).toBe(false);
  expect((await f.local()).code).toBe(1);
  expect(await f.remoteRef()).toBe("");
  expect(f.d.store.cleanups()[0]?.status).toBe("complete");
}, 30_000);

test("queued READY abandonment never grants automatic worktree retirement", async () => {
  const f = await fixture(false, "formaengine/forma-rs");
  const r = await retirable(f);
  const owner = f.d.store.lane("finished");
  if (!owner) throw new Error("missing fixture owner");
  f.d.store.saveLane({ ...owner, status: "ready", retiredAt: undefined });
  f.api.merged = false;
  f.d.landingBackend = ["fixture-queue"];
  f.intercept(async (cmd) => cmd === "fixture-queue" ? {
    code: 0, stderr: "",
    stdout: JSON.stringify({ repo: "formaengine/forma-rs", pr: 7, expectedHead: f.head, status: "queued" }),
  } : undefined);
  expect(await mergeGate(f.d, f.id)).toStartWith("QUEUED ");
  await done(f.d, "finished", { note: "phase abandoned without owner release" });
  f.api.merged = true;
  f.w.clock += f.d.tabCloseDelayMs;
  await dutyTick(f.d);
  expect(existsSync(r.path)).toBe(true);
  expect((await f.local()).code).toBe(0);
  expect(await f.remoteRef()).not.toBe("");
  expect(f.d.store.cleanups()[0]?.status).toBe("held");
}, 30_000);

const retirementHolds: readonly [string, (f: Fixture, r: Retirement) => Promise<void>][] = [
  ["dirty tracked files", async (_f, r) => { writeFileSync(join(r.path, "topic"), "uncommitted\n"); }],
  ["untracked work", async (_f, r) => { writeFileSync(join(r.path, "untracked"), "keep\n"); }],
  ["ignored content", async (f, r) => {
    writeFileSync(join(f.repo, ".git", "info", "exclude"), "\ncache/\n", { flag: "a" });
    mkdirSync(join(r.path, "cache"));
    writeFileSync(join(r.path, "cache", "keep"), "owner has not released this\n");
  }],
  ["locked worktree", async (f, r) => { await f.git("worktree", "lock", r.path); }],
  ["detached review snapshot", async (_f, r) => {
    const changed = await run("git", ["-C", r.path, "checkout", "--detach"]);
    if (changed.code !== 0) throw new Error(changed.stderr);
  }],
  ["owner is only READY", async (f) => {
    const lane = f.d.store.lane("finished")!;
    f.d.store.saveLane({ ...lane, status: "ready" });
  }],
  ["owner is lost", async (f) => {
    const lane = f.d.store.lane("finished")!;
    f.d.store.saveLane({ ...lane, status: "lost" });
  }],
  ["owner was not retired", async (f) => {
    const lane = f.d.store.lane("finished")!;
    f.d.store.saveLane({ ...lane, retiredAt: undefined });
  }],
  ["live paused owner", async (f) => { f.w.addPane("gone", "blocked"); }],
  ["another paused lane", async (f, r) => {
    f.d.store.saveLane({
      key: "paused", paneId: "paused-pane", tabId: "paused-tab", cwd: r.path, brief: "",
      status: "waiting", createdAt: 2, lastActivityAt: 2, nudges: 0, log: [],
    });
  }],
  ["another paused terminal", async (f, r) => { f.terminals([{ address: "other", state: "live", cwd: r.path }]); }],
  ["incomplete terminal metadata", async (f) => { f.terminals([{ address: "other", state: "live" }]); }],
  ["open process file", async (f, r) => {
    f.intercept(async (cmd) => cmd === "lsof"
      ? { code: 0, stdout: `p123\nn${realpathSync(r.path)}/topic\n`, stderr: "" } : undefined);
  }],
  ["incomplete process inventory", async (f) => {
    f.intercept(async (cmd) => cmd === "lsof"
      ? { code: 0, stdout: "p123\n", stderr: "some processes could not be inspected" } : undefined);
  }],
  ["stacked PR consumer", async (f) => {
    f.open.push([{ base: { ref: "topic" }, head: { ref: "child", repo: { full_name: "marti-s/cleanup-fixture" } } }]);
  }],
  ["additional post-merge commit", async (f) => {
    const tree = await f.git("rev-parse", `${f.head}^{tree}`);
    const extra = await f.git("commit-tree", tree, "-p", f.head, "-m", "new unlanded work");
    await f.git("update-ref", "refs/heads/topic", extra);
  }],
];

test.each(retirementHolds)("explicit retirement preserves the worktree and refs with %s", async (_name, protect) => {
  const f = await fixture(false);
  const r = await retirable(f);
  await protect(f, r);
  expect(await main(r.argv, f.d)).toBe(1);
  expect(await Bun.file(join(r.path, ".git")).exists()).toBe(true);
  expect((await f.local()).code).toBe(0);
  expect(await f.remoteRef()).not.toBe("");
}, 30_000);

test("retirement approval waits for independent merge confirmation, then duty completes it", async () => {
  const f = await fixture(true);
  const r = await retirable(f);
  f.api.merged = false;
  expect(await main(r.argv, f.d)).toBe(1);
  expect(await Bun.file(join(r.path, ".git")).exists()).toBe(true);
  expect(f.d.store.cleanups()[0]?.worktrees).toHaveLength(1);
  f.d.landingBackend = ["fixture-queue"];
  f.intercept(async (cmd) => cmd === "fixture-queue" ? {
    code: 0, stderr: "",
    stdout: JSON.stringify({ repo: "marti-s/cleanup-fixture", pr: 7, expectedHead: f.head, status: "queued" }),
  } : undefined);
  expect(await mergeGate(f.d, f.id)).toStartWith("QUEUED ");
  expect(f.d.store.cleanups()[0]?.worktrees).toHaveLength(1);
  expect(await Bun.file(join(r.path, ".git")).exists()).toBe(true);
  f.api.merged = true;
  const events = await dutyTick(f.d);
  expect(events.some((event) => event.action === "cleanup-complete")).toBe(true);
  expect(await Bun.file(join(r.path, ".git")).exists()).toBe(false);
  expect((await f.local()).code).toBe(1);
  expect(await f.remoteRef()).toBe("");
}, 30_000);

test.each(["owner replacement", "worktree replacement"])("stale retirement approval does not remove a reused %s", async (kind) => {
  const f = await fixture(false);
  const r = await retirable(f);
  f.api.merged = false;
  expect(await main(r.argv, f.d)).toBe(1);
  if (kind === "owner replacement") {
    f.d.store.saveLane({ ...f.d.store.lane("finished")!, createdAt: 99 });
  } else {
    await f.git("worktree", "remove", r.path);
    await f.git("worktree", "add", r.path, "topic");
  }
  f.api.merged = true;
  const events = await dutyTick(f.d);
  expect(events.some((event) => event.action === "cleanup-held")).toBe(true);
  expect(await Bun.file(join(r.path, ".git")).exists()).toBe(true);
  expect((await f.local()).code).toBe(0);
  expect(await f.remoteRef()).not.toBe("");
}, 30_000);

test("retirement dry-run removes nothing and grants no deferred authority", async () => {
  const f = await fixture(true);
  const r = await retirable(f);
  expect(await main([...r.argv, "--dry-run"], f.d)).toBe(0);
  expect(await Bun.file(join(r.path, ".git")).exists()).toBe(true);
  expect(f.d.store.cleanups()).toEqual([]);
  expect((await cleanupMergedPr(f.d, parsePr(f.id))).status).toBe("held");
  expect(await Bun.file(join(r.path, ".git")).exists()).toBe(true);
}, 30_000);

test("a proved unused worktree retires while an unlanded descendant keeps both source refs", async () => {
  const f = await fixture(false);
  const r = await retirable(f);
  const tree = await f.git("rev-parse", `${f.head}^{tree}`);
  const child = await f.git("commit-tree", tree, "-p", f.head, "-m", "unlanded dependent");
  await f.git("update-ref", "refs/heads/dependent", child);
  expect(await main(r.argv, f.d)).toBe(1);
  expect(await Bun.file(join(r.path, ".git")).exists()).toBe(false);
  expect(await f.git("rev-parse", "dependent")).toBe(child);
  expect((await f.local()).code).toBe(0);
  expect(await f.remoteRef()).toStartWith(f.head);
  expect(f.d.store.cleanups()[0]?.worktrees?.[0]?.removedAt).toBeDefined();
}, 30_000);

test("retirement remains idempotent after the squashed source object is collected", async () => {
  const f = await fixture(true);
  const r = await retirable(f);
  expect(await main(r.argv, f.d)).toBe(0);
  await f.git("reflog", "expire", "--expire=now", "--all");
  await f.git("gc", "--prune=now");
  const known = await run("git", ["-C", f.repo, "rev-parse", "--verify", "--quiet", `${f.head}^{commit}`]);
  expect(known.code).toBe(1);
  expect(await main(r.argv, f.d)).toBe(0);
  expect((await f.local()).code).toBe(1);
  expect(await f.remoteRef()).toBe("");
}, 30_000);

const protections: readonly [string, (f: Fixture) => Promise<void>][] = [
  ["unmerged PR", async (f) => { f.api.merged = false; }],
  ["merge into another base", async (f) => { f.api.base.ref = "release"; }],
  ["cross-repository head", async (f) => { f.api.head.repo.full_name = "someone/cleanup-fixture"; }],
  ["protected main", async (f) => { f.api.head.ref = "main"; }],
  ["open stacked consumer on a later page", async (f) => {
    f.open.push([{ base: { ref: "topic" }, head: { ref: "child", repo: { full_name: "marti-s/cleanup-fixture" } } }]);
  }],
  ["open PR sharing the head", async (f) => {
    f.open[0]?.push({ base: { ref: "main" }, head: { ref: "topic", repo: { full_name: "marti-s/cleanup-fixture" } } });
  }],
  ["incomplete dependency data", async (f) => { f.open[0]?.push({}); }],
  ["unknown origin", async (f) => {
    f.intercept(async (cmd, argv) => cmd === "git" && argv.includes("get-url")
      ? { code: 0, stdout: "https://github.com/sisyphuslabs/cleanup-fixture.git\n", stderr: "" } : undefined);
  }],
  ["a separate upstream push URL", async (f) => {
    f.intercept(async (cmd, argv) => cmd === "git" && argv.includes("get-url") && argv.includes("--push")
      ? { code: 0, stdout: "https://github.com/sisyphuslabs/cleanup-fixture.git\n", stderr: "" } : undefined);
  }],
  ["additional local commit", async (f) => {
    const tree = await f.git("rev-parse", `${f.head}^{tree}`);
    const extra = await f.git("commit-tree", tree, "-p", f.head, "-m", "unlanded");
    await f.git("update-ref", "refs/heads/topic", extra);
  }],
  ["advanced remote", async (f) => { await f.git("push", "origin", "main:refs/heads/topic"); }],
  ["unlanded local descendant", async (f) => {
    const tree = await f.git("rev-parse", `${f.head}^{tree}`);
    const child = await f.git("commit-tree", tree, "-p", f.head, "-m", "stacked work");
    await f.git("update-ref", "refs/heads/child", child);
  }],
  ["local upstream consumer", async (f) => {
    await f.git("branch", "consumer", "main");
    await f.git("branch", "--set-upstream-to=origin/topic", "consumer");
  }],
  ["clean checked-out source", async (f) => { await f.git("worktree", "add", join(f.root, "lane"), "topic"); }],
  ["dirty source worktree", async (f) => {
    const path = join(f.root, "lane");
    await f.git("worktree", "add", path, "topic");
    writeFileSync(join(path, "topic"), "uncommitted work\n");
  }],
  ["locked detached snapshot", async (f) => {
    await f.git("worktree", "add", "--detach", "--lock", join(f.root, "review"), f.head);
  }],
  ...(["working", "waiting", "ready"] as const).map((status): [string, (f: Fixture) => Promise<void>] => [
    `${status} lane still owns the PR`, async (f) => {
      const lane = f.d.store.lane("finished");
      if (!lane) throw new Error("missing fixture lane");
      f.d.store.saveLane({
        ...lane, status,
        final: { text: "held work", at: 0, evidence: ["https://github.com/marti-s/cleanup-fixture/pull/7"] },
      });
    },
  ]),
];

test.each(protections)("cleanup preserves both source refs with %s", async (_name, protect) => {
  const f = await fixture(false);
  await protect(f);
  const result = await cleanupMergedPr(f.d, parsePr(f.id));
  expect(result.status).toBe("held");
  expect((await f.local()).code).toBe(0);
  expect(await f.remoteRef()).not.toBe("");
}, 30_000);

test("dry run removes nothing and a completed deletion is idempotent", async () => {
  const f = await fixture(true);
  expect((await cleanupMergedPr(f.d, parsePr(f.id), { dryRun: true })).status).toBe("eligible");
  expect((await f.local()).code).toBe(0);
  expect(await f.remoteRef()).not.toBe("");
  expect(f.d.store.cleanups()).toEqual([]);
  expect((await cleanupMergedPr(f.d, parsePr(f.id))).status).toBe("complete");
  expect((await cleanupMergedPr(f.d, parsePr(f.id))).status).toBe("complete");
  expect((await f.local()).code).toBe(1);
  expect(await f.remoteRef()).toBe("");
}, 30_000);

test("CLI cleanup honors dry-run and reports a held PR with a nonzero exit", async () => {
  const f = await fixture(true);
  expect(await main(["cleanup", f.id, "--dry-run"], f.d)).toBe(0);
  expect((await f.local()).code).toBe(0);
  expect(await f.remoteRef()).not.toBe("");
  expect(f.d.store.cleanups()).toEqual([]);
  f.api.merged = false;
  expect(await main(["cleanup", f.id], f.d)).toBe(1);
  expect((await f.local()).code).toBe(0);
  expect(await f.remoteRef()).not.toBe("");
  expect(f.d.store.cleanups()[0]?.status).toBe("held");
}, 30_000);

test("a queued admission's original head cannot authorize cleanup of a different merged head", async () => {
  const f = await fixture(false);
  expect((await cleanupMergedPr(f.d, parsePr(f.id), { expectedHead: "a".repeat(40) })).status).toBe("held");
  expect((await f.local()).code).toBe(0);
  expect(await f.remoteRef()).not.toBe("");
}, 30_000);

test("a remote advance between proof and deletion is preserved by the deletion lease", async () => {
  const f = await fixture(false);
  let advanced = false;
  f.intercept(async (cmd, argv) => {
    if (cmd === "git" && argv.includes("push") && argv.includes(":refs/heads/topic") && !advanced) {
      advanced = true;
      await f.git("push", "origin", "main:refs/heads/topic");
    }
    return undefined;
  });
  expect((await cleanupMergedPr(f.d, parsePr(f.id))).status).toBe("held");
  expect(advanced).toBe(true);
  expect((await f.local()).code).toBe(0);
  expect(await f.remoteRef()).toStartWith(await f.git("rev-parse", "main"));
}, 30_000);

test("a local advance between proof and deletion is preserved by compare-and-delete", async () => {
  const f = await fixture(false);
  const tree = await f.git("rev-parse", `${f.head}^{tree}`);
  const extra = await f.git("commit-tree", tree, "-p", f.head, "-m", "concurrent unlanded work");
  f.intercept(async (cmd, argv) => {
    if (cmd === "git" && argv.includes("update-ref") && argv.includes("-d")) {
      await f.git("update-ref", "refs/heads/topic", extra);
    }
    return undefined;
  });
  expect((await cleanupMergedPr(f.d, parsePr(f.id))).status).toBe("held");
  expect(await f.git("rev-parse", "topic")).toBe(extra);
}, 30_000);

test("a checkout racing local deletion restores the source refs and keeps the worktree", async () => {
  const f = await fixture(false);
  const path = join(f.root, "racing-lane");
  let checkedOut = false;
  f.intercept(async (cmd, argv) => {
    if (cmd === "git" && argv.includes("update-ref") && argv.includes("-d") && !checkedOut) {
      checkedOut = true;
      await f.git("worktree", "add", path, "topic");
      writeFileSync(join(path, "uncommitted"), "keep this\n");
    }
    return undefined;
  });
  expect((await cleanupMergedPr(f.d, parsePr(f.id))).status).toBe("held");
  expect(checkedOut).toBe(true);
  expect((await f.local()).code).toBe(0);
  expect(await f.remoteRef()).toStartWith(f.head);
  expect(await Bun.file(join(path, "uncommitted")).text()).toBe("keep this\n");
}, 30_000);

test("queued landings wait for confirmed merge and duty resumes deferred cleanup after its stop is lifted", async () => {
  const f = await fixture(false);
  f.api.merged = false;
  f.d.landingBackend = ["fixture-queue"];
  f.intercept(async (cmd) => cmd === "fixture-queue" ? {
    code: 0, stderr: "",
    stdout: JSON.stringify({ repo: "marti-s/cleanup-fixture", pr: 7, expectedHead: f.head, status: "queued" }),
  } : undefined);
  expect(await mergeGate(f.d, f.id)).toStartWith("QUEUED ");
  expect((await f.local()).code).toBe(0);
  expect(await f.remoteRef()).not.toBe("");
  f.d.store.setStop(0, "paused", "duty");
  f.api.merged = true;
  expect(await dutyTick(f.d)).toEqual([{ action: "stopped", detail: "paused" }]);
  expect((await f.local()).code).toBe(0);
  f.d.store.clearStop("duty");
  expect(await dutyTick(f.d)).toContainEqual({
    action: "cleanup-complete", detail: `${f.id}: removed unused merged branch topic; linked worktrees kept`,
  });
  expect((await f.local()).code).toBe(1);
  expect(await f.remoteRef()).toBe("");
}, 30_000);
