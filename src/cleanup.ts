import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Deps, PrRef } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import type { CleanupRecord, WorktreeRetirement } from "./store.ts";
import { CommandError } from "./terminal.ts";

const SHA = /^[a-f0-9]{40}$/;
const githubRepo = (url: string): string | undefined =>
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1]?.toLowerCase();
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function field(value: Record<string, unknown>, key: string): string {
  const text = value[key];
  if (typeof text !== "string" || text.length === 0) throw new Refusal(`cleanup missing ${key}`);
  return text;
}

function gitIdentity(path: string): string {
  const stat = lstatSync(join(path, ".git"), { bigint: true });
  if (!stat.isFile()) throw new Refusal("retirement requires a linked worktree, not a primary clone or symlink");
  return `${stat.dev}:${stat.ino}:${stat.ctimeNs}`;
}

const within = (root: string, path: string) => path === root || path.startsWith(root + "/");
function canonical(path: string): string {
  const full = resolve(path);
  if (existsSync(full)) return realpathSync(full);
  const parent = dirname(full);
  return parent === full ? full : join(canonical(parent), basename(full));
}

/** GitHub is the merge authority, including squash/rebase; local ancestry alone never authorizes deletion. */
export async function cleanupMergedPr(
  d: Pick<Deps, "exec" | "store" | "now" | "herdr">,
  pr: PrRef,
  opts: {
    readonly expectedHead?: string;
    readonly dryRun?: boolean;
    readonly automatic?: boolean;
    readonly retire?: { readonly path: string; readonly owner: string; readonly head: string };
  } = {},
): Promise<CleanupRecord> {
  let sha = opts.expectedHead;
  const previous = d.store.cleanups().find((record) => record.pr === pr.id);
  let worktrees = [...previous?.worktrees ?? []];
  let clones = [...previous?.clones ?? []];
  const result = (status: CleanupRecord["status"], detail: string): CleanupRecord => {
    const record = { pr: pr.id, sha, status, detail, at: d.now(), worktrees, clones };
    if (!opts.dryRun) d.store.saveCleanup(record);
    return record;
  };
  const run = async (cmd: string, argv: readonly string[]): Promise<string> => {
    const answer = await d.exec(cmd, argv, { timeoutMs: 30_000 });
    if (answer.code !== 0 || answer.timedOut) throw new CommandError(cmd, argv, answer);
    return answer.stdout.trim();
  };
  const git = (cwd: string, ...argv: string[]) => run("git", ["-C", cwd, ...argv]);
  const api = async (path: string): Promise<unknown> => JSON.parse(await run("gh", ["api", path]));
  try {
    const stop = opts.automatic && d.store.stop("duty");
    if (stop) return result("pending", `automatic cleanup paused: ${stop.reason}`);
    if (opts.retire) {
      const requested = opts.retire;
      const path = canonical(requested.path);
      const owner = d.store.lane(requested.owner);
      const consumed = worktrees.find((entry) => entry.path === path && entry.owner === requested.owner &&
        entry.head === requested.head && entry.removedAt !== undefined);
      if (!SHA.test(requested.head) || !owner || canonical(owner.cwd) !== path) {
        throw new Refusal("retirement owner, path, or exact head does not match");
      }
      if (!consumed || existsSync(path)) {
        if (consumed) throw new Refusal("retired worktree path was reused; a new owner approval is required");
        if (await git(path, "rev-parse", "HEAD") !== requested.head) throw new Refusal("retirement head changed");
        const approval: WorktreeRetirement = {
          path, owner: owner.key, head: requested.head, paneId: owner.paneId, createdAt: owner.createdAt,
          gitIdentity: gitIdentity(path), at: d.now(),
        };
        worktrees = [...worktrees.filter((entry) => entry.path !== path), approval];
      }
      sha ??= requested.head;
    }
    const merged = async () => {
      const value = await api(`repos/${pr.repo}/pulls/${pr.number}`);
      if (!object(value) || value.number !== pr.number || value.merged !== true || value.state !== "closed" ||
          typeof value.merged_at !== "string" || !object(value.head) || !object(value.base) ||
          !object(value.head.repo) || !object(value.base.repo)) {
        throw new Refusal("PR is not confirmed merged");
      }
      if (field(value.base, "ref") !== "main" ||
          field(value.base.repo, "full_name").toLowerCase() !== pr.repo.toLowerCase() ||
          field(value.head.repo, "full_name").toLowerCase() !== pr.repo.toLowerCase()) {
        throw new Refusal("cleanup requires a same-repository PR merged into main");
      }
      const head = field(value.head, "sha");
      const commit = field(value, "merge_commit_sha");
      const branch = field(value.head, "ref");
      if (!SHA.test(head) || !SHA.test(commit) || ["main", "master", "HEAD"].includes(branch) ||
          (sha !== undefined && sha !== head)) throw new Refusal("cleanup head identity changed or is protected");
      return { head, commit, branch };
    };
    const source = await merged();
    sha = source.head;
    if (!opts.retire && worktrees.length === 0 && pr.repo.toLowerCase() === "formaengine/forma-rs") {
      const owners = d.store.lanes().filter((lane) => lane.status === "done" && lane.retiredAt !== undefined &&
        lane.log.findLast((entry) => entry.kind === "done")?.text === "closed by lead" &&
        lane.final?.evidence.some((link) => link.replace(/\/$/, "") === `https://github.com/${pr.repo}/pull/${pr.number}`));
      if (owners.length > 1) throw new Refusal("multiple retired owners require explicit worktree reconciliation");
      const owner = owners[0];
      if (owner) {
        const path = canonical(owner.cwd);
        if (await git(path, "rev-parse", "HEAD") !== source.head) throw new Refusal("retired owner head changed");
        worktrees = [{
          path, owner: owner.key, head: source.head, paneId: owner.paneId, createdAt: owner.createdAt,
          gitIdentity: gitIdentity(path), at: d.now(),
        }];
      }
    }
    const unused = async () => {
      const pages: unknown = JSON.parse(await run("gh", ["api", "--paginate", "--slurp", `repos/${pr.repo}/pulls?state=open&per_page=100`]));
      if (!Array.isArray(pages) || pages.length === 0 || !pages.every(Array.isArray)) {
        throw new Refusal("open PR dependency inventory is incomplete");
      }
      for (const page of pages) {
        for (const item of page) {
          if (!object(item) || !object(item.base) || !object(item.head) || !object(item.head.repo)) {
            throw new Refusal("open PR dependency identity is missing");
          }
          if (field(item.base, "ref") === source.branch ||
              (field(item.head, "ref") === source.branch && field(item.head.repo, "full_name").toLowerCase() === pr.repo.toLowerCase())) {
            throw new Refusal("an open or stacked PR still uses the branch");
          }
        }
      }
      for (const lane of d.store.lanes()) {
        if (lane.status !== "done" && lane.status !== "lost" &&
            lane.final?.evidence.some((link) => link.replace(/\/$/, "") === `https://github.com/${pr.repo}/pull/${pr.number}`)) {
          throw new Refusal(`lane ${lane.key} still owns the PR`);
        }
      }
    };
    await unused();
    const roots = new Map<string, string>();
    const candidates = new Set([process.cwd(), ...clones, ...d.store.lanes().map((lane) => lane.cwd), ...d.store.items().map((item) => item.cwd)]);
    for (const cwd of candidates) {
      const directory = await d.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 5_000 });
      if (directory.code !== 0 || directory.timedOut) continue;
      let root = directory.stdout.trim();
      // Use the primary worktree as a stable command context after an approved linked tree is removed.
      const primary = (await git(root, "worktree", "list", "--porcelain", "-z")).split("\0").find((line) => line.startsWith("worktree "));
      if (!primary) throw new Refusal("repository has no stable primary worktree");
      root = primary.slice("worktree ".length);
      const remote = await d.exec("git", ["-C", root, "remote", "get-url", "origin"], { timeoutMs: 5_000 });
      if (remote.code !== 0 || remote.timedOut || githubRepo(remote.stdout.trim()) !== pr.repo.toLowerCase()) continue;
      const pushes = (await git(root, "remote", "get-url", "--push", "--all", "origin")).split("\n");
      if (!pushes.length || pushes.some((url) => githubRepo(url) !== pr.repo.toLowerCase())) {
        throw new Refusal("origin push URLs do not match the PR repository");
      }
      const common = await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
      roots.set(common, root);
    }
    if (roots.size === 0) throw new Refusal("no known local clone has the matching origin");
    clones = [...roots.values()];
    const reference = `refs/heads/${source.branch}`;
    const retirements = new Map<string, { root: string; approval: WorktreeRetirement }>();
    const verifyRetirement = async (root: string, approval: WorktreeRetirement) => {
      if (approval.removedAt !== undefined || approval.head !== source.head || gitIdentity(approval.path) !== approval.gitIdentity) {
        throw new Refusal("retirement identity is stale or already consumed");
      }
      const owner = d.store.lane(approval.owner);
      if (!owner || owner.paneId !== approval.paneId || owner.createdAt !== approval.createdAt ||
          canonical(owner.cwd) !== approval.path || owner.status !== "done" || owner.retiredAt === undefined) {
        throw new Refusal("retirement owner is active, paused, replaced, lost, or not retired");
      }
      const inventory = (await git(root, "worktree", "list", "--porcelain", "-z")).split("\0\0");
      const entry = inventory.find((block) => block.split("\0").includes(`worktree ${approval.path}`));
      const fields = entry?.split("\0");
      if (!fields?.includes(`branch ${reference}`) || !fields.includes(`HEAD ${source.head}`) ||
          fields.some((line) => /^(locked|prunable)( |$)/.test(line))) {
        throw new Refusal("retirement requires the exact unlocked source worktree; snapshots and protected trees stay");
      }
      for (const lane of d.store.lanes()) {
        if (!within(approval.path, canonical(lane.cwd))) continue;
        if (lane.status !== "done" || lane.retiredAt === undefined || await d.herdr.status(lane.paneId) !== "gone") {
          throw new Refusal(`worktree still has an active or paused lane: ${lane.key}`);
        }
      }
      if (d.store.items().some((item) => within(approval.path, canonical(item.cwd)) && item.status !== "done" && item.status !== "dropped")) {
        throw new Refusal("backlog work still owns the retirement directory");
      }
      if (!d.herdr.directoryInUse || await d.herdr.directoryInUse(approval.path)) {
        throw new Refusal("worktree terminal inactivity is not established");
      }
      if (within(approval.path, canonical(process.cwd()))) throw new Refusal("cleanup cannot remove its own working directory");
      const files = await d.exec("lsof", ["-nP", "-Fn"], { timeoutMs: 30_000 });
      if (files.code !== 0 || files.timedOut || files.stderr || !/^p\d+/m.test(files.stdout)) {
        throw new Refusal("worktree open-file inventory is unavailable or incomplete");
      }
      if (files.stdout.split("\n").some((line) => line.startsWith("n") && within(approval.path, line.slice(1)))) {
        throw new Refusal("a process still uses the worktree");
      }
      const dirty = await git(approval.path, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching");
      if (dirty) throw new Refusal("worktree has tracked, untracked, or ignored content; retained");
    };
    const remoteHead = async (root: string) => {
      const text = await git(root, "ls-remote", "--heads", "origin", reference);
      if (!text) return undefined;
      const [head, ref] = text.split(/\s+/);
      if (head !== source.head || ref !== reference) throw new Refusal("remote branch has additional or different work");
      return head;
    };
    const local = async (root: string, checkDescendants = true) => {
      // Linked trees are held unless this exact owner/run/path has explicit, freshly verified retirement.
      const linked = (await git(root, "worktree", "list", "--porcelain", "-z")).split("\0\0");
      for (const entry of linked) {
        const fields = entry.split("\0");
        if (fields.includes(`branch ${reference}`) || (fields.includes("detached") && fields.includes(`HEAD ${source.head}`))) {
          const path = fields.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
          const approval = worktrees.find((approved) => approved.path === path);
          if (!approval) throw new Refusal("a linked worktree or snapshot still uses the branch head");
          await verifyRetirement(root, approval);
          retirements.set(approval.path, { root, approval });
        }
      }
      const refs = (await git(root, "for-each-ref", "--format=%(refname)%09%(objectname)%09%(upstream)", "refs/heads")).split("\n");
      let present = false;
      for (const line of refs.filter(Boolean)) {
        const [ref, head, upstream] = line.split("\t");
        if (ref === reference) {
          if (head !== source.head) throw new Refusal("local branch has additional or different work");
          present = true;
        } else if (upstream === `refs/remotes/origin/${source.branch}`) {
          throw new Refusal("another local branch tracks the source branch");
        }
      }
      if (!checkDescendants) return present;
      const known = await d.exec("git", ["-C", root, "rev-parse", "--verify", "--quiet", `${source.head}^{commit}`]);
      // A completed squash cleanup can outlive its unreachable source object. No local ref is removed in this case.
      if (known.code === 1 && !known.timedOut && !present) return false;
      if (known.code !== 0 || known.timedOut) throw new Refusal("local source history cannot be verified");
      const descendants = await git(root, "for-each-ref", `--contains=${source.head}`, "--format=%(refname)", "refs/heads");
      for (const ref of descendants.split("\n").filter((name) => name && name !== reference)) {
        const answer = await d.exec("git", ["-C", root, "merge-base", "--is-ancestor", ref, "refs/remotes/origin/main"]);
        if (answer.code !== 0 || answer.timedOut) throw new Refusal("an unlanded local branch depends on the source head");
      }
      return present;
    };
    for (const root of roots.values()) {
      await git(root, "check-ref-format", reference);
      if (await git(root, "rev-parse", "--is-shallow-repository") !== "false") throw new Refusal("shallow clone cannot prove local dependencies");
      await git(root, "fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main");
      await git(root, "merge-base", "--is-ancestor", source.commit, "refs/remotes/origin/main");
      if (await remoteHead(root)) await git(root, "fetch", "--no-tags", "origin", reference);
      await local(root, false);
    }
    // Re-read the authorities immediately before mutation; failures and partial inventories always hold cleanup.
    if (JSON.stringify(await merged()) !== JSON.stringify(source)) throw new Refusal("merge identity changed");
    await unused();
    if (opts.dryRun) {
      for (const root of roots.values()) await local(root);
      return result("eligible", `verified unused merged branch ${source.branch}; no refs removed`);
    }
    // Persist instance-bound approvals and stable clone roots before any removal so duty can recover partial cleanup.
    result("pending", "merged identity and dependencies verified; cleanup in progress");
    for (const { root, approval } of retirements.values()) {
      await verifyRetirement(root, approval);
      await git(root, "worktree", "remove", approval.path);
      worktrees = worktrees.map((entry) => entry.path === approval.path ? { ...entry, removedAt: d.now() } : entry);
      result("pending", `retired ${approval.path}; source-ref cleanup pending`);
    }
    const deleted: { root: string; local: boolean; remote: boolean }[] = [];
    try {
      for (const root of roots.values()) {
        const present = await local(root);
        const change = { root, local: false, remote: false };
        deleted.push(change);
        if (await remoteHead(root)) {
          // A deletion lease compares the exact remote head; it never overwrites a concurrently advanced ref.
          await git(root, "push", `--force-with-lease=${reference}:${source.head}`, "origin", `:${reference}`);
          change.remote = true;
          if (await remoteHead(root)) throw new Refusal("remote branch still exists after deletion");
        }
        if (present) {
          await local(root);
          await git(root, "update-ref", "-d", reference, source.head);
          change.local = true;
          // A checkout can race the last preflight. Restore our exact deleted refs if a new user appears.
          await local(root);
        }
      }
    } catch (error) {
      for (const change of deleted.reverse()) {
        if (change.local) {
          const current = await git(change.root, "for-each-ref", "--format=%(refname)", reference);
          if (!current) await git(change.root, "update-ref", reference, source.head, "0".repeat(40));
        }
        if (change.remote && !await git(change.root, "ls-remote", "--heads", "origin", reference)) {
          // Empty expectation only recreates a missing ref; concurrent replacement work is never overwritten.
          await git(change.root, "push", `--force-with-lease=${reference}:`, "origin", `${source.head}:${reference}`);
        }
      }
      throw error;
    }
    const retired = worktrees.filter((entry) => entry.removedAt !== undefined).map((entry) => entry.path);
    return result("complete", `removed unused merged branch ${source.branch}; ${retired.length ? `retired ${retired.join(", ")}` : "linked worktrees kept"}`);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const detail = error instanceof CommandError ? error.result.stderr || error.result.stdout || error.message : error.message;
    return result("held", detail.trim().slice(0, 1000));
  }
}
