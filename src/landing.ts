import type { PrRef } from "./gate.ts";
import type { Deps } from "./harness.ts";
import { attestBootstrap } from "./native-bootstrap.ts";
import { Refusal } from "./refusal.ts";

/** The repository whose landings go through its own queue: never a direct GitHub merge, never a dry run. */
export const NATIVE_QUEUE_REPO = "formaengine/forma-rs";

const SHA = /^[a-f0-9]{40}$/i;
const PYTHON = /(^|\/)(python|pypy)(\d+(\.\d+)*)?$/i;
const NATIVE_ADAPTER = ".agents/workflows/landing-verifier.py";

export const isNativeQueue = (pr: PrRef): boolean => pr.repo.toLowerCase() === NATIVE_QUEUE_REPO;

/** LANDING_BACKEND as the backend's argv: a JSON array of an executable and its literal arguments, parsed once. */
export function landingBackendArgv(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const message = "LANDING_BACKEND must be a JSON nonempty array of nonempty strings";
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    throw new Refusal(message);
  }
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.length > 0 && v.every((arg: unknown) => typeof arg === "string" && arg.trim().length > 0);
  if (!strings(value)) throw new Refusal(message);
  return value;
}

const text = (value: unknown): value is string => typeof value === "string";
const sha = (value: unknown): value is string => text(value) && SHA.test(value);

/** The argv to run: the configured backend, or for the native queue's Python adapter the attested, isolated one. */
async function backendArgv(d: Deps, backend: readonly string[], pr: PrRef, head: string): Promise<readonly string[]> {
  const python = backend.some((arg) => PYTHON.test(arg) || arg.toLowerCase().includes(NATIVE_ADAPTER));
  if (!isNativeQueue(pr) || !(d.formaQueueBootstrap || python)) return backend;
  const pin = d.formaQueueBootstrap === undefined ? {} : { pin: d.formaQueueBootstrap };
  return attestBootstrap(d.exec, backend, { ...pin, repo: pr.repo, pr: pr.number, head });
}

/**
 * Hands the PR at `head` to the landing backend: its argv with `--repo --pr --expected-head` appended, never through a
 * shell. The backend must exit 0 and print one JSON object whose identity matches the request. `queued` is admission
 * only; `landed` must name the landed head, the landed tree and the queue's own evidence. Returns the line to print.
 */
export async function land(
  d: Deps,
  backend: readonly string[],
  pr: PrRef,
  head: string,
): Promise<{ readonly line: string; readonly landed: boolean }> {
  if (!SHA.test(head)) throw new Refusal("MERGE_REFUSED landing backend requires a full head SHA");
  const [command, ...argv] = await backendArgv(d, backend, pr, head);
  if (!command) throw new Refusal("MERGE_REFUSED landing backend has no executable");
  const result = await d.exec(command, [
    ...argv,
    "--repo",
    pr.repo,
    "--pr",
    String(pr.number),
    "--expected-head",
    head,
  ]);
  if (result.timedOut || result.code !== 0) {
    const how = result.timedOut ? "timed out" : `exited ${result.code}`;
    const reason = result.stderr.trim().slice(-2000);
    throw new Refusal(`MERGE_REFUSED landing backend ${how}${reason ? `: ${reason}` : ""}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    throw new Refusal("MERGE_REFUSED landing backend must return exactly one JSON object");
  }
  const receipt: Record<string, unknown> =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {};
  const { repo, pr: number, expectedHead, status, landedHead, landedTree, receipt: evidence } = receipt;
  if (repo !== pr.repo || number !== pr.number || expectedHead !== head || status === undefined)
    throw new Refusal("MERGE_REFUSED landing backend receipt does not match request identity");
  if (status === "queued") return { line: `QUEUED ${pr.id} head=${head}`, landed: false };
  if (status !== "landed") throw new Refusal("MERGE_REFUSED landing backend returned an unknown status");
  if (!sha(landedHead) || !sha(landedTree) || !text(evidence) || evidence.trim().length === 0)
    throw new Refusal(
      "MERGE_REFUSED landing backend landed receipt requires landedHead, landedTree and queue evidence",
    );
  const line = `MERGED ${pr.id} head=${head} landedHead=${landedHead} landedTree=${landedTree} receipt=${evidence}`;
  return { line, landed: true };
}
