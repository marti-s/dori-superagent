import { join } from "node:path";
import { agentCommandArgv } from "./agent-command.ts";
import { prompt, type Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { loadHooks, substitute } from "./hooks.ts";
import { createReviewAttempt, saveReviewAttempt, saveReviewOutput } from "./receipts.ts";
import type { MergeOutcome } from "./telemetry.ts";

export type PrRef = { repo: string; number: number; id: string };

export function parsePr(s: string): PrRef {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (!m) throw new Refusal(`PR must look like owner/repo#123, got ${s}`);
  return { repo: m[1]!, number: Number(m[2]), id: s };
}

async function gh(d: Deps, argv: readonly string[]): Promise<string> {
  const r = await d.exec("gh", argv);
  if (r.code !== 0) throw new Error(`gh ${argv.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export async function headSha(d: Deps, pr: PrRef): Promise<string> {
  const out = JSON.parse(await gh(d, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "headRefOid"]));
  return String(out.headRefOid);
}

type Verdict = "CLEAR" | "BLOCK";
/** The receipt summary keeps both ends: the verdict summary and the worst findings come first, the VERDICT line last. */
const SUMMARY_MAX = 4000;
const summaryOf = (full: string): string =>
  full.length <= SUMMARY_MAX ? full : `${full.slice(0, 2000)}\n[... see the full review ...]\n${full.slice(-1960)}`;

/**
 * Runs a fresh, non-interactive reviewer session pinned to the PR head and records its verdict as a receipt. A run is
 * killed at the review deadline, a run that prints no VERDICT line is tried once more, and every run leaves its
 * output, its result and its session file in its own attempt directory. The reviewer's whole output is kept beside
 * the receipt, also when the review fails.
 */
export async function review(
  d: Deps,
  prId: string,
  model?: string,
): Promise<{ verdict: Verdict; sha: string; review: string }> {
  const pr = parsePr(prId);
  // hooks.reviewCommand replaces the built-in reviewer; it must print a VERDICT line like the built-in one.
  const hook = loadHooks(d.store.root).reviewCommand;
  const sha = await headSha(d, pr);
  const vars = { pr: pr.id, repo: pr.repo, number: String(pr.number), sha };
  const text = prompt("review.md", vars);
  const label = hook ? "hook" : (model ?? "default");
  const minutes = d.reviewTimeoutMs / 60_000;
  const keep = (out: string): string => saveReviewOutput(d.store.root, pr.id, sha, out);
  let found: { verdict: Verdict; full: string } | undefined;
  for (let attempt = 1; found === undefined; attempt++) {
    const directory = createReviewAttempt(d.store.root, pr.id, sha);
    const session = join(directory, "session.jsonl");
    const [cmd, ...argv] = hook
      ? substitute(hook, { ...vars, text })
      : [...agentCommandArgv(d.agentCmd), "-p", "--session", session, ...(model ? ["--model", model] : []), text];
    const startedAt = d.now();
    const res = await d.exec(cmd ?? d.agentCmd, argv, { timeoutMs: d.reviewTimeoutMs });
    const timedOut = res.timedOut ?? false;
    const diagnostics = saveReviewAttempt(directory, {
      ...{ pr: pr.id, sha, attempt, model: label, session, startedAt, finishedAt: d.now() },
      ...{ code: res.code, timedOut, stdout: res.stdout, stderr: res.stderr },
    });
    process.stderr.write(`dori: reviewer attempt ${attempt} diagnostics: ${diagnostics}\n`);
    const out = res.stdout.trim();
    const last = [...res.stdout.matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)].at(-1);
    if (timedOut && !last) {
      // A run killed before any verdict is not retried: it would only run into the same deadline.
      const kept = out ? `; its output so far: ${keep(out)}` : "";
      throw new Error(
        `reviewer timed out after ${minutes} min; no receipt written; diagnostics: ${diagnostics}${kept}`,
      );
    }
    if (timedOut) {
      // The reviewer prints its whole answer only once the review is finished, and can then stay alive until the
      // deadline: a VERDICT already in that output is a finished review.
      const note = `printed its VERDICT but kept running until the ${minutes} min deadline; receipt written from that output`;
      process.stderr.write(`dori: the reviewer of ${pr.id} ${note}\n`);
    } else if (res.code !== 0) {
      throw new Error(`reviewer exited ${res.code}: ${res.stderr.trim()}; diagnostics: ${diagnostics}`);
    }
    if (last) found = { verdict: last[1] as Verdict, full: out };
    else if (attempt === 2) {
      const twice = "reviewer printed no VERDICT line twice; no receipt written";
      throw new Error(`${twice}; diagnostics: ${diagnostics}; its output: ${keep(out)}`);
    } else keep(out);
  }
  const { verdict, full } = found;
  const receipt = d.store.saveReceipt(
    { pr: pr.id, sha, verdict, model: label, at: d.now(), summary: summaryOf(full) },
    full,
  );
  d.usage.record({ name: "dori.review_completed", verdict });
  return { verdict, sha, review: receipt.review };
}

type Check = { name: string; bucket: string };

/** Merge only when the exact current head has a CLEAR review receipt and every check passed. An empty check list is never green. */
export async function mergeGate(d: Deps, prId: string, opts: { dryRun?: boolean } = {}): Promise<string> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  const refused = await gateRefusal(d, pr, sha);
  if (refused) {
    if (!opts.dryRun) d.usage.record({ name: "dori.merge_decided", outcome: refused[0] });
    throw new Refusal(`MERGE_REFUSED ${refused[1]}`);
  }
  if (opts.dryRun) return `MERGE_OK ${pr.id} head=${sha} (dry run)`;
  await gh(d, ["pr", "merge", String(pr.number), "--repo", pr.repo, "--squash", "--match-head-commit", sha]);
  d.usage.record({ name: "dori.merge_decided", outcome: "merged" });
  return `MERGED ${pr.id} head=${sha}`;
}

async function gateRefusal(d: Deps, pr: PrRef, sha: string): Promise<[MergeOutcome, string] | undefined> {
  const receipt = d.store.receipt(pr.id, sha);
  if (!receipt) return ["no_receipt", `no review receipt at head ${sha.slice(0, 12)} (run: dori review ${pr.id})`];
  if (receipt.verdict !== "CLEAR") return ["review_block", `review at ${sha.slice(0, 12)} is ${receipt.verdict}`];
  const checksRes = await d.exec("gh", ["pr", "checks", String(pr.number), "--repo", pr.repo, "--json", "name,bucket"]);
  const checks: Check[] = checksRes.stdout.trim().startsWith("[") ? JSON.parse(checksRes.stdout) : [];
  if (checks.length === 0) return ["no_checks", "no checks reported: an empty check list is never green"];
  const bad = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  if (bad.length > 0) return ["checks_red", `checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(", ")}`];
  if (!checks.some((c) => c.bucket === "pass")) return ["checks_all_skipped", "every check was skipped"];
  return undefined;
}
