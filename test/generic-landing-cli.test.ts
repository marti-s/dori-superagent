import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
  cleanup,
  GENERIC,
  backendCalls,
  dori,
  head,
  merges,
  receipt,
  reviewed,
  sandbox,
} from "./native-landing-cli-setup.ts";

afterEach(cleanup);

describe("generic o/r landing is unchanged", () => {
  test("empty checks still refuse even though the head is CLEAR", async () => {
    const fx = sandbox();
    await reviewed(fx, GENERIC);
    writeFileSync(fx.f("checks"), "[]");
    writeFileSync(fx.f("backend-out"), receipt(GENERIC));

    const r = await dori(fx, ["merge", `${GENERIC}#7`], { backend: true });

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no checks reported");
    expect(backendCalls(fx)).toEqual([]);
    expect(merges(fx)).toEqual([]);
  });

  test("green checks with a backend queue through it, not through gh merge", async () => {
    const fx = sandbox();
    await reviewed(fx, GENERIC);
    writeFileSync(fx.f("backend-out"), receipt(GENERIC));

    const r = await dori(fx, ["merge", `${GENERIC}#7`], { backend: true });

    expect(r.stdout).toBe(`QUEUED ${GENERIC}#7 head=${head}\n`);
    expect(backendCalls(fx)).toEqual([["--repo", GENERIC, "--pr", "7", "--expected-head", head]]);
    expect(merges(fx)).toEqual([]);
  });

  test("green checks without a backend squash-merge pinned to the head", async () => {
    const fx = sandbox();
    await reviewed(fx, GENERIC);

    const r = await dori(fx, ["merge", `${GENERIC}#7`]);

    expect(r.stdout).toBe(`MERGED ${GENERIC}#7 head=${head}\n`);
    expect(merges(fx)).toEqual([["pr", "merge", "7", "--repo", GENERIC, "--squash", "--match-head-commit", head]]);
  });

  test("dry-run with green checks still reports MERGE_OK and merges nothing", async () => {
    const fx = sandbox();
    await reviewed(fx, GENERIC);

    const r = await dori(fx, ["merge", `${GENERIC}#7`, "--dry-run"]);

    expect(r.stdout).toBe(`MERGE_OK ${GENERIC}#7 head=${head} (dry run)\n`);
    expect(merges(fx)).toEqual([]);
  });
});
