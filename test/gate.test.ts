import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mergeGate, review } from "../src/gate.ts";
import { reviewTimeoutMinutes } from "../src/harness.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

describe("review + merge gate", () => {
  const head = "a".repeat(40);
  function gh(w: World, checks: unknown[]) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify(checks) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  test("merge is refused without a receipt, with an empty check list, with red checks; allowed at CLEAR + green", async () => {
    const { w, d } = setup();
    gh(w, []);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 ...\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#7")).verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("is BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#7", "some/model");
    expect(d.store.receipt("o/r#7", head)!.model).toBe("some/model");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    gh(w, [
      { name: "test", bucket: "fail" },
      { name: "lint", bucket: "pass" },
    ]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("every check was skipped");
    gh(w, [
      { name: "test", bucket: "pass" },
      { name: "docs", bucket: "skipping" },
    ]);
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
    expect(w.calls.at(-1)!.argv).toContain("--match-head-commit");
    expect(
      w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome),
    ).toEqual(["no_receipt", "review_block", "no_checks", "checks_red", "checks_all_skipped", "merged"]);
    expect(w.usage.filter((e) => e.name === "dori.review_completed")).toHaveLength(2);
  });

  test("a review longer than 4000 characters keeps its start and its end: the full text is saved beside the receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    const findings = Array.from(
      { length: 200 },
      (_, i) => `MEDIUM src/f${i}.ts:${i} a finding long enough to fill the review`,
    ).join("\n");
    const stdout = `SUMMARY: two blocking bugs\nHIGH src/a.ts:1 the most severe finding\n${findings}\nVERDICT: BLOCK`;
    expect(stdout.length).toBeGreaterThan(4000);
    w.reviewer = () => ({ code: 0, stdout });
    const r = await review(d, "o/r#9");
    const receipt = d.store.receipt("o/r#9", head);
    expect(receipt?.review).toBe(r.review);
    expect(r.review).toBe(join(d.store.root, "receipts", `o__r_9@${head}.md`));
    expect(readFileSync(r.review, "utf8")).toBe(`${stdout}\n`);
    expect(statSync(r.review).mode & 0o777).toBe(0o600);
    expect(receipt?.summary.length).toBeLessThanOrEqual(4000);
    expect(receipt?.summary).toStartWith("SUMMARY: two blocking bugs\nHIGH src/a.ts:1 the most severe finding");
    expect(receipt?.summary).toEndWith("VERDICT: BLOCK");
  });

  test("the built-in reviewer is run with a fresh session file per attempt and the review deadline", async () => {
    const { w, d } = setup();
    gh(w, []);
    const runs: { argv: readonly string[]; timeoutMs: number | undefined }[] = [];
    const exec: typeof d.exec = (cmd, argv, options) => {
      if (cmd === "omo") runs.push({ argv, timeoutMs: options?.timeoutMs });
      return w.exec(cmd, argv, options);
    };
    await review({ ...d, exec }, "o/r#10", "some/model");
    expect(runs).toHaveLength(1);
    const [mode, flag, session, ...rest] = runs[0]?.argv ?? [];
    expect([mode, flag, rest.slice(0, 2)]).toEqual(["-p", "--session", ["--model", "some/model"]]);
    expect(session).toMatch(new RegExp(`/receipts/o__r_10@${head}\\.attempts/attempt-[A-Za-z0-9]{6}/session\\.jsonl$`));
    expect(runs[0]?.timeoutMs).toBe(25 * 60_000);
  });

  test("DORI_REVIEW_TIMEOUT_MIN sets the reviewer timeout; unset is 25 minutes and a bad value is refused", () => {
    expect(reviewTimeoutMinutes(undefined)).toBe(25);
    expect(reviewTimeoutMinutes("")).toBe(25);
    expect(reviewTimeoutMinutes("40")).toBe(40);
    for (const bad of ["0", "-3", "soon"])
      expect(() => reviewTimeoutMinutes(bad)).toThrow("DORI_REVIEW_TIMEOUT_MIN must be a positive number of minutes");
  });
});
