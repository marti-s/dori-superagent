import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Refusal } from "./refusal.ts";
import type { Exec } from "./terminal.ts";

export type FormaQueueBootstrap = {
  readonly repo: string;
  readonly pr: number;
  readonly head: string;
  readonly tree: string;
};

const SHA = /^[a-f0-9]{40}$/i;
const ADAPTER = ".atomic/workflows/dori-landing.py";

/** Explicit configuration is parsed once by defaultDeps, never read from ambient env during admission. */
export function parseFormaQueueBootstrap(raw: string | undefined): FormaQueueBootstrap | undefined {
  if (raw === undefined) return undefined;
  const message = "FORMA_QUEUE_BOOTSTRAP must be JSON exactly {repo,pr,head,tree} with a repository slug, positive integer PR and full head/tree SHAs";
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Refusal(message);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "head,pr,repo,tree" ||
      !("repo" in value) || typeof value.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(value.repo) ||
      !("pr" in value) || typeof value.pr !== "number" || !Number.isSafeInteger(value.pr) || value.pr <= 0 ||
      !("head" in value) || typeof value.head !== "string" || !SHA.test(value.head) ||
      !("tree" in value) || typeof value.tree !== "string" || !SHA.test(value.tree)) {
    throw new Refusal(message);
  }
  return Object.freeze({ repo: value.repo, pr: value.pr, head: value.head, tree: value.tree });
}

/** Attest only source metadata/files before returning the restricted Python invocation. */
export async function attestBootstrap(
  exec: Exec,
  backend: readonly string[],
  request: { readonly pin?: FormaQueueBootstrap; readonly repo: string; readonly pr: number; readonly head: string },
): Promise<readonly string[]> {
  const refuse = (reason: string): never => { throw new Refusal(`MERGE_REFUSED bootstrap ${reason.slice(0, 2000)}`); };
  const { pin } = request;
  if (pin && (request.repo !== pin.repo || request.pr !== pin.pr || request.head !== pin.head)) refuse("request does not match FORMA_QUEUE_BOOTSTRAP");
  const [command, script] = backend;
  // python3 comes from the trusted caller's PATH. A configured executable cannot substitute another entrypoint.
  if (command !== "python3" || backend.length !== 2 || !script || !isAbsolute(script) ||
      resolve(script) !== script || !script.endsWith(`/${ADAPTER}`)) {
    throw new Refusal("MERGE_REFUSED bootstrap backend must be exactly [\"python3\", \"/absolute/source/.atomic/workflows/dori-landing.py\"]");
  }
  const source = dirname(dirname(dirname(script)));
  const workflow = dirname(script);
  let operation = "source paths";
  try {
    if (realpathSync(script) !== script || !lstatSync(script).isFile()) refuse("source adapter path must be canonical and cannot traverse a symlink");
    const git = async (...argv: string[]): Promise<string> => {
      operation = argv[0] === "merge-base" ? "source origin/main ancestor check" : `source git ${argv[0]}`;
      const result = await exec("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", source, ...argv], { timeoutMs: 30_000 });
      if (result.timedOut || result.code !== 0) {
        refuse(`${operation} ${result.timedOut ? "timed out" : `exited ${result.code}`}: ${(result.stderr || result.stdout).trim()}`);
      }
      return result.stdout;
    };
    if ((await git("rev-parse", "--show-toplevel")).trim() !== source) refuse("adapter is not at the source repository root");
    const origin = (await git("config", "--get", "remote.origin.url")).trim();
    const slug = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(origin)?.[1];
    if (slug?.toLowerCase() !== request.repo.toLowerCase()) refuse("source origin does not match the requested repository");
    await git("fetch", "--no-tags", "--no-recurse-submodules", "origin", "+refs/heads/main:refs/remotes/origin/main");
    const head = (await git("rev-parse", "HEAD")).trim();
    if (pin) {
      if (head !== pin.head) refuse("source HEAD does not match the pinned expected head");
      if ((await git("rev-parse", "HEAD^{tree}")).trim() !== pin.tree) refuse("source HEAD tree does not match the pin");
      await git("merge-base", "--is-ancestor", "refs/remotes/origin/main", "HEAD");
    } else if (head !== (await git("rev-parse", "refs/remotes/origin/main")).trim()) {
      refuse("unpinned source must be at freshly fetched origin/main; a branch requires FORMA_QUEUE_BOOTSTRAP");
    }
    if ((await git("status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none")).trim()) refuse("source is dirty (tracked or untracked files)");
    const entries = (await git("ls-files", "-v", "-z")).split("\0").filter(Boolean);
    if (entries.some((entry) => /^[a-zS]/.test(entry))) refuse("source index hides tracked files (assume-unchanged or skip-worktree)");
    const tracked = new Set(entries.map((entry) => entry.slice(2)));
    if (!tracked.has(ADAPTER)) refuse("source adapter is not tracked");
    operation = "source import root";
    const inspect = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const name = relative(source, path);
        // Reject all workflow symlinks: following even an internal link adds cycles/aliases to the import boundary.
        if (entry.isSymbolicLink()) refuse(`source import root contains a symlink: ${name}`);
        if (entry.name === "__pycache__" || (!tracked.has(name) && /\.(py|pyc|pyo|so|pyd|pth)$/i.test(entry.name))) {
          refuse(`source import artifact is not trusted: ${name}`);
        }
        if (entry.isDirectory()) inspect(path);
      }
    };
    inspect(workflow);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (!(error instanceof Error)) throw error;
    refuse(`${operation} failed: ${error.message}`);
  }
  return ["python3", "-I", "-S", "-B", script];
}
