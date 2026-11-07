import { expect, test } from "bun:test";
import { mergeGate } from "../src/harness.ts";
import type { Exec } from "../src/terminal.ts";
import { World } from "./fake.ts";

const repo = "formaengine/forma-rs";
const pr = `${repo}#7`;
const head = "a".repeat(40);
const backend = "/trusted-native-queue";

function setup(checks: readonly { readonly name: string; readonly bucket: string }[] = []) {
  const w = new World();
  const d = { ...w.deps(), landingBackend: [backend] };
  w.gh = (argv) => ({
    code: 0,
    stdout: JSON.stringify(argv[1] === "view" ? { headRefOid: head } : checks),
  });
  d.store.saveReceipt({ pr, sha: head, verdict: "CLEAR", model: "default", at: w.clock, summary: "clear" }, "VERDICT: CLEAR");
  const landed = {
    status: "landed", repo, pr: 7, expectedHead: head,
    candidateHead: "b".repeat(40), candidateTree: "c".repeat(40), receipt: "queue://landings/42",
  };
  w.reviewer = () => ({ code: 0, stdout: JSON.stringify(landed) });
  return { w, d, landed };
}

test.each([
  ["empty", []],
  ["all skipped", [{ name: "source", bucket: "skipping" }]],
  ["failed", [{ name: "source", bucket: "fail" }]],
  ["pending", [{ name: "source", bucket: "pending" }]],
] as const)("native candidate verification delegates %s source checks to the trusted backend", async (_name, checks) => {
  const { w, d } = setup(checks);
  w.reviewer = (argv) => ({
    code: 0,
    stdout: JSON.stringify({
      status: "queued", repo: argv[argv.indexOf("--repo") + 1],
      pr: Number(argv[argv.indexOf("--pr") + 1]), expectedHead: argv[argv.indexOf("--expected-head") + 1],
    }),
  });

  expect(await mergeGate(d, pr)).toBe(`QUEUED ${pr} head=${head}`);
  expect(w.calls.filter((c) => c.cmd !== "gh")).toEqual([{
    cmd: backend, argv: ["--repo", repo, "--pr", "7", "--expected-head", head],
  }]);
  expect(w.calls.some((c) => c.cmd === "gh" && c.argv[1] !== "view")).toBe(false);
  expect(w.usage).toEqual([]);
});

test("native landed output retains correlated candidate and queue evidence", async () => {
  const { w, d, landed } = setup();

  expect(await mergeGate(d, pr)).toBe(
    `MERGED ${pr} head=${head} candidateHead=${landed.candidateHead} candidateTree=${landed.candidateTree} receipt=${landed.receipt}`,
  );
  expect(w.usage).toEqual([{ name: "dori.merge_decided", outcome: "merged" }]);
});

test.each([
  [false, repo], [true, repo],
  [false, "FormaEngine/Forma-Rs"], [true, "FormaEngine/Forma-Rs"],
  [false, "FORMAENGINE/FORMA-RS"], [true, "FORMAENGINE/FORMA-RS"],
] as const)("native admission requires an explicit backend with dryRun=%p and repo=%s", async (dryRun, requestedRepo) => {
  const { w, d } = setup([{ name: "source", bucket: "pass" }]);
  const requestedPr = `${requestedRepo}#7`;
  d.store.saveReceipt({ pr: requestedPr, sha: head, verdict: "CLEAR", model: "default", at: w.clock, summary: "clear" }, "VERDICT: CLEAR");
  const { landingBackend: _backend, ...withoutBackend } = d;

  await expect(mergeGate(withoutBackend, requestedPr, { dryRun })).rejects.toThrow("native landing requires");
  expect(w.calls.filter((c) => c.cmd === backend || c.argv[1] === "merge")).toEqual([]);
});

test("native dry run refuses without pretending to verify or submitting", async () => {
  const { w, d } = setup([{ name: "source", bucket: "pass" }]);

  await expect(mergeGate(d, pr, { dryRun: true })).rejects.toThrow("native dry-run is unavailable");
  expect(w.calls.filter((c) => c.cmd === backend || c.argv[1] === "merge")).toEqual([]);
  expect(w.usage).toEqual([]);
});

test.each([
  ["missing", "formaengine/forma-rs#8", head, "CLEAR", "no review receipt"],
  ["stale", pr, "d".repeat(40), "CLEAR", "no review receipt"],
  ["blocked", pr, head, "BLOCK", "is BLOCK"],
] as const)("native admission refuses a %s exact-head CLEAR receipt", async (_name, receiptPr, sha, verdict, reason) => {
  const { w, d } = setup();
  const fresh = w.deps();
  fresh.store.saveReceipt({ pr: receiptPr, sha, verdict, model: "default", at: w.clock, summary: "review" }, `VERDICT: ${verdict}`);

  await expect(mergeGate({ ...d, store: fresh.store }, pr)).rejects.toThrow(reason);
  expect(w.calls.filter((c) => c.cmd === backend || c.argv[1] === "merge")).toEqual([]);
});

test("native admission refuses head movement before submitting", async () => {
  const { w, d } = setup();
  let reads = 0;
  w.gh = () => ({ code: 0, stdout: JSON.stringify({ headRefOid: ++reads === 1 ? head : "d".repeat(40) }) });

  await expect(mergeGate(d, pr)).rejects.toThrow("head moved");
  expect(w.calls.filter((c) => c.cmd === backend || c.argv[1] === "merge")).toEqual([]);
});

test.each([
  ["queued wrong repository", { status: "queued", repo: "other/repo" }],
  ["queued wrong PR", { status: "queued", pr: 8 }],
  ["queued wrong head", { status: "queued", expectedHead: "d".repeat(40) }],
  ["landed wrong head", { expectedHead: "d".repeat(40) }],
  ["landed missing candidate", { candidateHead: undefined }],
  ["landed invalid tree", { candidateTree: "z".repeat(40) }],
  ["landed missing evidence", { receipt: undefined }],
])("native backend refuses %s without falling back", async (_name, change) => {
  const { w, d, landed } = setup();
  w.reviewer = () => ({ code: 0, stdout: JSON.stringify({ ...landed, ...change }) });

  await expect(mergeGate(d, pr)).rejects.toThrow("landing backend");
  expect(w.calls.filter((c) => c.cmd === backend)).toHaveLength(1);
  expect(w.calls.some((c) => c.cmd === "gh" && c.argv[1] === "merge")).toBe(false);
  expect(w.usage).toEqual([]);
});

test("native backend verification refusal cannot become a GitHub merge", async () => {
  const { w, d } = setup();
  w.reviewer = () => ({ code: 1, stdout: "candidate evidence rejected" });
  const exec: Exec = async (command, argv, options) => {
    const result = await w.exec(command, argv, options);
    return command === backend ? { ...result, stderr: "landing refused: checker approval missing at expected head" } : result;
  };

  await expect(mergeGate({ ...d, exec }, pr)).rejects.toThrow("landing backend exited 1: landing refused: checker approval missing at expected head");
  expect(w.calls.filter((c) => c.cmd === backend)).toHaveLength(1);
  expect(w.calls.some((c) => c.cmd === "gh" && c.argv[1] === "merge")).toBe(false);
  expect(w.usage).toEqual([]);
});
