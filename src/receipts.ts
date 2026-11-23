import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewReceipt } from "./store-types.ts";

// Review records under <home>/receipts/, all named after the PR and the exact head: `<pr>@<sha>.json` is the receipt,
// `<pr>@<sha>.md` the reviewer's whole output, `<pr>@<sha>.attempts/attempt-*/` what each reviewer run left behind.
// A reviewer reads the code under review and may quote it, so its output is written for the owner only.
const PRIVATE = 0o600;

const receiptPath = (root: string, pr: string, sha: string, ext: string): string =>
  join(root, "receipts", `${pr.replaceAll("/", "__").replace("#", "_")}@${sha}.${ext}`);

/** One reviewer run: what it was asked, how it ended, and everything it printed. */
export type ReviewAttempt = {
  readonly pr: string;
  readonly sha: string;
  readonly attempt: number;
  readonly model: string;
  readonly session: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly code: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

/** A fresh directory reserved before the reviewer starts, so a run can never resume another run's session. */
export function createReviewAttempt(root: string, pr: string, sha: string): string {
  const attempts = receiptPath(root, pr, sha, "attempts");
  mkdirSync(attempts, { recursive: true });
  return mkdtempSync(join(attempts, "attempt-"));
}

/** Keeps the run's stdout, stderr and result in its directory, each written once, and returns the result file. */
export function saveReviewAttempt(directory: string, record: ReviewAttempt): string {
  const { stdout, stderr, ...metadata } = record;
  writeFileSync(join(directory, "stdout"), stdout, { flag: "wx", mode: PRIVATE });
  writeFileSync(join(directory, "stderr"), stderr, { flag: "wx", mode: PRIVATE });
  const path = join(directory, "result.json");
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: PRIVATE });
  return path;
}

/** Writes a reviewer's whole output where its receipt goes (`<pr>@<sha>.md`), receipt or not, and returns the path. */
export function saveReviewOutput(root: string, pr: string, sha: string, fullText: string): string {
  const review = receiptPath(root, pr, sha, "md");
  const tmp = `${review}.${process.pid}.tmp`;
  writeFileSync(tmp, fullText.endsWith("\n") ? fullText : `${fullText}\n`, { mode: PRIVATE });
  renameSync(tmp, review);
  return review;
}

/** Writes the reviewer's whole output beside the receipt, then the receipt pointing at it. */
export function saveReceipt(root: string, r: Omit<ReviewReceipt, "review">, fullText: string): ReviewReceipt {
  const receipt: ReviewReceipt = { ...r, review: saveReviewOutput(root, r.pr, r.sha, fullText) };
  const path = receiptPath(root, r.pr, r.sha, "json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(tmp, path);
  return receipt;
}

export function readReceipt(root: string, pr: string, sha: string): ReviewReceipt | undefined {
  const path = receiptPath(root, pr, sha, "json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ReviewReceipt) : undefined;
}
