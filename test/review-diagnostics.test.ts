import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { mergeGate, review } from "../src/harness.ts";
import type { ExecResult } from "../src/terminal.ts";
import { World } from "./fake.ts";

const pr = "sandbox/review#9001";
const sha = "a".repeat(40);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Attempt = {
  readonly pr: string; readonly sha: string; readonly attempt: number; readonly model: string;
  readonly session: string; readonly startedAt: number; readonly finishedAt: number;
  readonly code: number; readonly timedOut: boolean;
};

function setup(outputs: readonly ExecResult[]) {
  const w = new World();
  const base = w.deps();
  roots.push(base.store.root);
  w.gh = (argv) => ({ code: 0, stdout: JSON.stringify(
    argv.includes("headRefOid") ? { headRefOid: sha } : [{ name: "test", bucket: "pass" }],
  ) });
  const invocations: { session: string; timeoutMs: number | undefined }[] = [];
  const d = { ...base, exec: async (cmd: string, argv: readonly string[], opts?: { readonly timeoutMs?: number }) => {
    if (cmd !== base.agentCmd) return w.exec(cmd, argv, opts);
    const output = outputs[invocations.length % outputs.length];
    if (!output) throw new Error("unexpected reviewer invocation");
    const sessionIndex = argv.indexOf("--session");
    const session = sessionIndex < 0 ? undefined : argv[sessionIndex + 1];
    if (!session || argv.includes("--no-session")) throw new Error("reviewer requires a durable session");
    // Consume the actual path: reused sessions fail instead of silently overwriting prior evidence.
    writeFileSync(session, JSON.stringify({ invocation: invocations.length + 1 }) + "\n", { flag: "wx" });
    invocations.push({ session, timeoutMs: opts?.timeoutMs });
    w.clock += 37;
    return output;
  } };
  return { w, d, invocations };
}

function attempts(root: string) {
  const directory = join(root, "receipts", `sandbox__review_9001@${sha}.attempts`);
  return readdirSync(directory).map((name) => {
    expect(name).toMatch(/^attempt-[A-Za-z0-9]{6}$/);
    const path = join(directory, name);
    const result: Attempt = JSON.parse(readFileSync(join(path, "result.json"), "utf8"));
    return { path, result, stdout: readFileSync(join(path, "stdout"), "utf8"), stderr: readFileSync(join(path, "stderr"), "utf8") };
  }).sort((a, b) => a.result.startedAt - b.result.startedAt);
}

test.each([
  ["empty0", "", ""],
  ["stderr0", "", " \nprovider startup failed\t\n"],
  ["first nonempty then empty", " \npartial findings without verdict\t\n", ""],
])("%s retains two independent raw attempts and refuses a receipt", async (_name, first, stderr) => {
  const { d, invocations } = setup([{ code: 0, stdout: first, stderr }, { code: 0, stdout: "", stderr }]);

  const error = await review(d, pr).catch((e: unknown) => e);

  expect(String(error)).toContain("no VERDICT line twice; no receipt written");
  expect(d.store.receipt(pr, sha)).toBeUndefined();
  expect(invocations).toHaveLength(2);
  const kept = attempts(d.store.root);
  expect(kept.map((a) => a.stdout)).toEqual([first, ""]);
  expect(kept.map((a) => a.stderr)).toEqual([stderr, stderr]);
  expect(new Set(kept.map((a) => a.path)).size).toBe(2);
  for (const [index, artifact] of kept.entries()) {
    expect(artifact.result).toEqual({
      pr, sha, attempt: index + 1, model: "default", session: join(artifact.path, "session.jsonl"),
      startedAt: 1_000_000 + index * 37, finishedAt: 1_000_000 + (index + 1) * 37,
      code: 0, timedOut: false,
    });
    expect(readFileSync(artifact.result.session, "utf8")).toBe(JSON.stringify({ invocation: index + 1 }) + "\n");
  }
  const last = kept.at(-1);
  expect(last).toBeDefined();
  if (!last) throw new Error("missing last diagnostic");
  expect(String(error)).toContain(last.path);
});

test.each(["CLEAR", "BLOCK"] as const)("a valid %s verdict keeps the exact-head receipt and raw diagnostics", async (verdict) => {
  const stdout = ` \nfindings\nVERDICT: ${verdict}\n `;
  const { d, w } = setup([{ code: 0, stdout, stderr: "warning\n" }]);

  const result = await review(d, pr, "fixture/model");

  expect(result).toEqual({ verdict, sha, review: join(d.store.root, "receipts", `sandbox__review_9001@${sha}.md`) });
  expect(d.store.receipt(pr, sha)).toEqual({
    pr, sha, verdict, model: "fixture/model", at: w.clock, summary: stdout.trim(), review: result.review,
  });
  expect(readFileSync(result.review, "utf8")).toBe(`${stdout.trim()}\n`);
  const kept = attempts(d.store.root);
  expect(kept).toHaveLength(1);
  expect(kept[0]?.stdout).toBe(stdout);
  expect(kept[0]?.stderr).toBe("warning\n");
  expect(d.store.receipt(pr, "b".repeat(40))).toBeUndefined();
  w.gh = (argv) => ({ code: 0, stdout: JSON.stringify(
    argv.includes("headRefOid") ? { headRefOid: "b".repeat(40) } : [{ name: "test", bucket: "pass" }],
  ) });
  await expect(mergeGate(d, pr, { dryRun: true })).rejects.toThrow("no review receipt");
});

test("retry verdict uses only the successful answer while retaining the first attempt", async () => {
  const { d, invocations } = setup([
    { code: 0, stdout: "unfinished\n", stderr: "first warning\n" },
    { code: 0, stdout: "VERDICT: BLOCK\nVERDICT: CLEAR\n", stderr: "" },
  ]);

  const result = await review(d, pr);

  expect(result.verdict).toBe("CLEAR");
  expect(invocations).toHaveLength(2);
  expect(readFileSync(result.review, "utf8")).toBe("VERDICT: BLOCK\nVERDICT: CLEAR\n");
  expect(attempts(d.store.root).map((a) => [a.stdout, a.stderr, a.result.attempt])).toEqual([
    ["unfinished\n", "first warning\n", 1], ["VERDICT: BLOCK\nVERDICT: CLEAR\n", "", 2],
  ]);
});

test.each([
  ["nonzero", { code: 23, stdout: "VERDICT: CLEAR\n", stderr: " \nfailure\t\n" }, "reviewer exited 23"],
  ["deadline", { code: 137, stdout: "", stderr: " \ninterrupted\t\n", timedOut: true }, "reviewer timed out"],
  ["partial deadline", { code: 137, stdout: "half a review\n", stderr: "", timedOut: true }, "reviewer timed out"],
])("%s retains failure diagnostics without retry or receipt", async (_name, output, message) => {
  const { d, invocations } = setup([output]);

  const error = await review(d, pr).catch((e: unknown) => e);

  expect(String(error)).toContain(message);
  expect(invocations.map((i) => i.timeoutMs)).toEqual([25 * 60_000]);
  expect(d.store.receipt(pr, sha)).toBeUndefined();
  const kept = attempts(d.store.root);
  expect(kept).toHaveLength(1);
  const artifact = kept[0];
  if (!artifact) throw new Error("missing failure diagnostics");
  expect([artifact.stdout, artifact.stderr]).toEqual([output.stdout, output.stderr]);
  expect(artifact.result).toEqual({
    pr, sha, attempt: 1, model: "default", session: join(artifact.path, "session.jsonl"),
    startedAt: 1_000_000, finishedAt: 1_000_037, code: output.code, timedOut: "timedOut" in output,
  });
  expect(String(error)).toContain(artifact.path);
});

test.each(["CLEAR", "BLOCK"] as const)("deadline after %s still writes its receipt and timed-out diagnostics", async (verdict) => {
  const { d, invocations } = setup([{ code: 137, stdout: `VERDICT: ${verdict}\n`, stderr: "killed\n", timedOut: true }]);

  const result = await review(d, pr);

  expect(result.verdict).toBe(verdict);
  expect(d.store.receipt(pr, sha)?.verdict).toBe(verdict);
  expect(invocations).toHaveLength(1);
  expect(attempts(d.store.root).map((a) => [a.result.code, a.result.timedOut, a.stdout, a.stderr])).toEqual([
    [137, true, `VERDICT: ${verdict}\n`, "killed\n"],
  ]);
});

test("repeat reviews retain fresh sessions and all earlier artifacts", async () => {
  const { d, invocations } = setup([{ code: 0, stdout: "", stderr: "retained\n" }]);
  await review(d, pr).catch((e: unknown) => e);
  const earlier = attempts(d.store.root).map((a) => ({
    path: a.path, files: readdirSync(a.path).sort().map((name) => [name, readFileSync(join(a.path, name), "utf8")]),
  }));

  const error = await review(d, pr).catch((e: unknown) => e);

  expect(String(error)).toContain("no VERDICT line twice");
  expect(invocations).toHaveLength(4);
  expect(new Set(invocations.map((i) => i.session)).size).toBe(4);
  expect(attempts(d.store.root).map((a) => a.result.attempt)).toEqual([1, 2, 1, 2]);
  for (const saved of earlier) {
    expect(readdirSync(saved.path).sort().map((name) => [name, readFileSync(join(saved.path, name), "utf8")])).toEqual(saved.files);
  }
  for (const [index, invocation] of invocations.entries()) {
    expect(basename(invocation.session)).toBe("session.jsonl");
    expect(existsSync(join(dirname(invocation.session), "result.json"))).toBe(true);
    expect(readFileSync(invocation.session, "utf8")).toBe(JSON.stringify({ invocation: index + 1 }) + "\n");
  }
});
