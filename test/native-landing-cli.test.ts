import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
  cleanup,
  NATIVE,
  SKIPPED,
  backendCalls,
  dori,
  head,
  landed,
  landedHead,
  landedTree,
  merges,
  moved,
  receipt,
  reviewed,
  sandbox,
} from "./native-landing-cli-setup.ts";

afterEach(cleanup);

describe("native formaengine/forma-rs landing", () => {
  test("backend queued output is QUEUED, never merged, with empty source-head checks", async () => {
    const fx = sandbox();
    await reviewed(fx, NATIVE);
    writeFileSync(fx.f("checks"), "[]");
    writeFileSync(fx.f("backend-out"), receipt(NATIVE));

    const r = await dori(fx, ["merge", `${NATIVE}#7`], { backend: true });

    expect(r).toEqual({ code: 0, stdout: `QUEUED ${NATIVE}#7 head=${head}\n`, stderr: "" });
    expect(backendCalls(fx)).toEqual([["--repo", NATIVE, "--pr", "7", "--expected-head", head]]);
    expect(merges(fx)).toEqual([]);
  });

  test("skipped-only source-head checks still reach the backend", async () => {
    const fx = sandbox();
    await reviewed(fx, NATIVE);
    writeFileSync(fx.f("checks"), SKIPPED);
    writeFileSync(fx.f("backend-out"), receipt(NATIVE));

    const r = await dori(fx, ["merge", `${NATIVE}#7`], { backend: true });

    expect(r.stdout).toBe(`QUEUED ${NATIVE}#7 head=${head}\n`);
    expect(backendCalls(fx)).toHaveLength(1);
    expect(merges(fx)).toEqual([]);
  });

  test("matching correlated landed receipt is MERGED without a direct gh merge", async () => {
    const fx = sandbox();
    await reviewed(fx, NATIVE);
    writeFileSync(fx.f("checks"), "[]");
    writeFileSync(fx.f("backend-out"), landed(NATIVE));

    const r = await dori(fx, ["merge", `${NATIVE}#7`], { backend: true });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      `MERGED ${NATIVE}#7 head=${head} landedHead=${landedHead} landedTree=${landedTree} receipt=queue-receipt-1\n`,
    );
    expect(backendCalls(fx)).toHaveLength(1);
    expect(merges(fx)).toEqual([]);
  });

  test("absent backend refuses with no direct gh merge fallback", async () => {
    const fx = sandbox();
    await reviewed(fx, NATIVE);
    writeFileSync(fx.f("checks"), "[]");

    const r = await dori(fx, ["merge", `${NATIVE}#7`]);

    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("MERGE_REFUSED");
    expect(backendCalls(fx)).toEqual([]);
    expect(merges(fx)).toEqual([]);
  });

  test("a BLOCK review refuses before the backend is touched", async () => {
    const fx = sandbox();
    await reviewed(fx, NATIVE, "BLOCK");
    writeFileSync(fx.f("backend-out"), receipt(NATIVE));

    const r = await dori(fx, ["merge", `${NATIVE}#7`], { backend: true });

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("MERGE_REFUSED");
    expect(r.stdout).not.toMatch(/QUEUED|MERGED/);
    expect(backendCalls(fx)).toEqual([]);
    expect(merges(fx)).toEqual([]);
  });

  test("no receipt, or a receipt for an older head, refuses before the backend", async () => {
    const fx = sandbox();
    writeFileSync(fx.f("backend-out"), receipt(NATIVE));
    const none = await dori(fx, ["merge", `${NATIVE}#7`], { backend: true });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("MERGE_REFUSED");

    await reviewed(fx, NATIVE);
    writeFileSync(fx.f("head"), moved);
    const stale = await dori(fx, ["merge", `${NATIVE}#7`], { backend: true });
    expect(stale.code).toBe(2);
    expect(stale.stderr).toContain("MERGE_REFUSED");
    expect(stale.stdout).not.toMatch(/QUEUED|MERGED/);
    expect(backendCalls(fx)).toEqual([]);
    expect(merges(fx)).toEqual([]);
  });

  test.each([
    ["non-JSON output", "queued!", 0],
    ["two JSON objects", `${receipt(NATIVE)}\n${receipt(NATIVE)}`, 0],
    ["unrelated PR identity", receipt(NATIVE, { pr: 8 }), 0],
    ["unrelated repo identity", receipt("other/repo"), 0],
    ["unrelated head", receipt(NATIVE, { expectedHead: moved }), 0],
    ["unknown status", receipt(NATIVE, { status: "pending" }), 0],
    ["landed without queue evidence", landed(NATIVE, { receipt: "" }), 0],
    ["landed with bad landed tree", landed(NATIVE, { landedTree: "xyz" }), 0],
    [
      "landed with only candidate fields",
      landed(NATIVE, {
        landedHead: undefined,
        landedTree: undefined,
        candidateHead: landedHead,
        candidateTree: landedTree,
      }),
      0,
    ],
    ["backend failure with a matching receipt", receipt(NATIVE), 1],
  ])("malformed or failed backend (%s) refuses without fallback", async (_name, out, backendCode) => {
    const fx = sandbox();
    await reviewed(fx, NATIVE);
    writeFileSync(fx.f("checks"), "[]");
    writeFileSync(fx.f("backend-out"), out);
    writeFileSync(fx.f("backend-code"), String(backendCode));

    const r = await dori(fx, ["merge", `${NATIVE}#7`], { backend: true });

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("MERGE_REFUSED");
    expect(r.stdout).not.toMatch(/QUEUED|MERGED/);
    expect(backendCalls(fx)).toHaveLength(1);
    expect(merges(fx)).toEqual([]);
  });

  test.each([false, true])(
    "dry-run never claims MERGE_OK from CLEAR alone (backend configured: %p)",
    async (backend) => {
      const fx = sandbox();
      await reviewed(fx, NATIVE);
      writeFileSync(fx.f("checks"), "[]");
      writeFileSync(fx.f("backend-out"), landed(NATIVE));

      const r = await dori(fx, ["merge", `${NATIVE}#7`, "--dry-run"], { backend });

      expect(r.stdout).not.toContain("MERGE_OK");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("MERGE_REFUSED");
      expect(backendCalls(fx)).toEqual([]);
      expect(merges(fx)).toEqual([]);
    },
  );
});
