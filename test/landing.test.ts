import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { mergeGate } from "../src/gate.ts";
import { Refusal } from "../src/refusal.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

describe("a configured landing backend", () => {
  const head = "a".repeat(40);
  function gh(w: World, checks: unknown[]) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify(checks) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  function landingSetup() {
    const { w, d } = setup();
    gh(w, [
      { name: "test", bucket: "pass" },
      { name: "docs", bucket: "skipping" },
    ]);
    d.store.saveReceipt(
      { pr: "o/r#7", sha: head, verdict: "CLEAR", model: "default", at: w.clock, summary: "clear" },
      "VERDICT: CLEAR",
    );
    const landed = {
      status: "landed",
      repo: "o/r",
      pr: 7,
      expectedHead: head,
      landedHead: "b".repeat(40),
      landedTree: "c".repeat(40),
      receipt: "queue://landings/42",
    };
    return { w, d: { ...d, landingBackend: ["/backend with spaces", "submit", "$(touch nope); literal"] }, landed };
  }

  test.each(["queued", "landed"])(
    "configured landing prints %s through the merge CLI with literal argv",
    async (status) => {
      const { w, d, landed } = landingSetup();
      w.reviewer = () => ({
        code: 0,
        stdout: JSON.stringify(
          status === "landed"
            ? landed
            : {
                status,
                repo: "o/r",
                pr: 7,
                expectedHead: head,
              },
        ),
      });
      const lines: string[] = [];
      const log = console.log;
      console.log = (...args: unknown[]) => void lines.push(args.join(" "));
      try {
        expect(await main(["merge", "o/r#7"], d)).toBe(0);
      } finally {
        console.log = log;
      }
      expect(lines).toEqual([
        status === "queued"
          ? `QUEUED o/r#7 head=${head}`
          : `MERGED o/r#7 head=${head} landedHead=${landed.landedHead} landedTree=${landed.landedTree} receipt=${landed.receipt}`,
      ]);
      expect(w.calls.filter((c) => c.cmd === d.landingBackend[0])).toEqual([
        {
          cmd: "/backend with spaces",
          argv: ["submit", "$(touch nope); literal", "--repo", "o/r", "--pr", "7", "--expected-head", head],
        },
      ]);
      expect(w.calls.some((c) => c.cmd === "gh" && c.argv[1] === "merge")).toBe(false);
      expect(w.usage.filter((e) => e.name === "dori.merge_decided")).toEqual(
        status === "queued" ? [] : [{ name: "dori.merge_decided", outcome: "merged" }],
      );
    },
  );

  test.each([
    ["nonzero exit", { code: 1, stdout: "", stderr: "queue refused" }],
    ["timeout even with a receipt", { code: 0, stdout: "landed", timedOut: true }],
    ["spawn failure", undefined],
    ["malformed JSON", { code: 0, stdout: "not json" }],
    ["two JSON objects", { code: 0, stdout: "{}\n{}" }],
    ["JSON array", { code: 0, stdout: "[]" }],
    ["JSON null", { code: 0, stdout: "null" }],
  ] as const)("configured landing refuses %s without falling back", async (_name, result) => {
    const { w, d, landed } = landingSetup();
    const exec = async (cmd: string, argv: readonly string[]) => {
      if (cmd !== d.landingBackend[0]) return w.exec(cmd, argv);
      w.calls.push({ cmd, argv });
      if (!result) throw new Error("backend missing");
      return { stderr: "", ...result, stdout: result.stdout === "landed" ? JSON.stringify(landed) : result.stdout };
    };
    await expect(mergeGate({ ...d, exec }, "o/r#7")).rejects.toThrow();
    expect(w.calls.filter((c) => c.cmd === d.landingBackend[0])).toHaveLength(1);
    expect(w.calls.some((c) => c.cmd === "gh" && c.argv[1] === "merge")).toBe(false);
    expect(w.usage).toEqual([]);
  });

  test.each([
    ["unrelated repo", { repo: "other/repo" }],
    ["unrelated PR", { pr: 8 }],
    ["string PR", { pr: "7" }],
    ["unrelated head", { expectedHead: "d".repeat(40) }],
    ["unknown status", { status: "merged" }],
    ["missing status", { status: undefined }],
    ["missing landed head", { landedHead: undefined }],
    ["short landed head", { landedHead: "abcd" }],
    ["nonhex landed tree", { landedTree: "z".repeat(40) }],
    ["missing landed tree", { landedTree: undefined }],
    [
      "only candidate fields",
      { landedHead: undefined, landedTree: undefined, candidateHead: "b".repeat(40), candidateTree: "c".repeat(40) },
    ],
    ["missing queue evidence", { receipt: undefined }],
    ["empty queue evidence", { receipt: "" }],
    ["blank queue evidence", { receipt: " \n " }],
    ["nonstring queue evidence", { receipt: { path: "queue://landings/42" } }],
    ["queued unrelated head", { status: "queued", expectedHead: "d".repeat(40) }],
    ["queued unrelated repo", { status: "queued", repo: "other/repo" }],
    ["queued unrelated PR", { status: "queued", pr: 8 }],
  ])("configured landing rejects %s in the backend receipt", async (_name, change) => {
    const { w, d, landed } = landingSetup();
    w.reviewer = () => ({ code: 0, stdout: JSON.stringify({ ...landed, ...change }) });
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("landing backend");
    expect(w.calls.some((c) => c.cmd === "gh" && c.argv[1] === "merge")).toBe(false);
    expect(w.usage).toEqual([]);
  });

  test("configured landing refuses a head moved during admission before invoking the backend", async () => {
    const { w, d } = landingSetup();
    let reads = 0;
    const admitted = w.gh;
    w.gh = (argv) =>
      argv[1] === "view" && ++reads === 2
        ? { code: 0, stdout: JSON.stringify({ headRefOid: "d".repeat(40) }) }
        : admitted(argv);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("head moved");
    expect(reads).toBe(2);
    expect(w.calls.filter((c) => c.cmd === d.landingBackend[0] || c.argv[1] === "merge")).toEqual([]);
  });

  test("configured landing dry run keeps admission without invoking the backend", async () => {
    const { w, d } = landingSetup();
    expect(await mergeGate(d, "o/r#7", { dryRun: true })).toBe(`MERGE_OK o/r#7 head=${head} (dry run)`);
    expect(w.calls.filter((c) => c.cmd === d.landingBackend[0] || c.argv[1] === "merge")).toEqual([]);
    expect(w.usage).toEqual([]);
  });

  test.each([
    ["no receipt", undefined, "CLEAR", []],
    ["BLOCK review", head, "BLOCK", []],
    ["empty checks", head, "CLEAR", []],
    ["all skipped", head, "CLEAR", [{ name: "test", bucket: "skipping" }]],
    ["red checks", head, "CLEAR", [{ name: "test", bucket: "fail" }]],
    ["pending checks", head, "CLEAR", [{ name: "test", bucket: "pending" }]],
  ] as const)(
    "configured landing preserves %s refusal in live and dry runs",
    async (_name, receiptHead, verdict, checks) => {
      for (const dryRun of [false, true]) {
        const { w, d } = setup();
        gh(w, [...checks]);
        if (receiptHead)
          d.store.saveReceipt(
            { pr: "o/r#7", sha: receiptHead, verdict, model: "default", at: w.clock, summary: "review" },
            `VERDICT: ${verdict}`,
          );
        await expect(mergeGate({ ...d, landingBackend: ["backend"] }, "o/r#7", { dryRun })).rejects.toThrow(Refusal);
        expect(w.calls.filter((c) => c.cmd === "backend" || c.argv[1] === "merge")).toEqual([]);
      }
    },
  );
});
