import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Drives the real src/cli.ts as a subprocess. gh, the omo reviewer and the landing queue are process fakes on a
// private PATH; every invocation is logged so tests can prove what was (not) called.
const cli = resolve(import.meta.dir, "../src/cli.ts");
const NATIVE = "formaengine/forma-rs";
const GENERIC = "o/r";
const head = "a".repeat(40);
const moved = "d".repeat(40);
const landedHead = "b".repeat(40);
const landedTree = "c".repeat(40);
const GREEN = '[{"name":"build","bucket":"pass"}]';
const SKIPPED = '[{"name":"build","bucket":"skipping"}]';

type Fixture = ReturnType<typeof sandbox>;
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function script(path: string, body: string): void {
  writeFileSync(path, `#!${process.execPath}\nimport { appendFileSync, readFileSync, existsSync } from "node:fs";\n${body}`);
  chmodSync(path, 0o755);
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "dori-native-landing-"));
  roots.push(root);
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);
  const f = (name: string) => join(root, name);
  writeFileSync(f("head"), head);
  writeFileSync(f("checks"), GREEN);
  writeFileSync(f("verdict"), "CLEAR");
  writeFileSync(f("backend-out"), "");
  writeFileSync(f("backend-code"), "0");
  script(join(bin, "gh"), `
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(f("gh.jsonl"))}, JSON.stringify(argv) + "\\n");
if (argv[0] === "pr" && argv[1] === "view") {
  console.log(JSON.stringify({ headRefOid: readFileSync(${JSON.stringify(f("head"))}, "utf8") }));
} else if (argv[0] === "pr" && argv[1] === "checks") {
  process.stdout.write(readFileSync(${JSON.stringify(f("checks"))}, "utf8"));
} else if (argv[0] === "pr" && argv[1] === "merge") {
  appendFileSync(${JSON.stringify(f("merge.jsonl"))}, JSON.stringify(argv) + "\\n");
} else { console.error("sandbox gh refuses " + argv.join(" ")); process.exit(91); }
`);
  script(join(bin, "agent"), `
console.log("review text\\nVERDICT: " + readFileSync(${JSON.stringify(f("verdict"))}, "utf8"));
`);
  script(join(bin, "backend"), `
appendFileSync(${JSON.stringify(f("backend.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(readFileSync(${JSON.stringify(f("backend-out"))}, "utf8"));
process.exit(Number(readFileSync(${JSON.stringify(f("backend-code"))}, "utf8")));
`);
  return { root, bin, home, f };
}

const lines = (path: string): string[][] =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const merges = (fx: Fixture) => lines(fx.f("merge.jsonl"));
const backendCalls = (fx: Fixture) => lines(fx.f("backend.jsonl"));

async function dori(fx: Fixture, args: string[], opts: { backend?: boolean } = {}) {
  const env: Record<string, string> = {
    PATH: fx.bin, HOME: fx.root, DORI_HOME: fx.home, DORI_TELEMETRY: "0",
    DORI_AGENT_CMD: join(fx.bin, "agent"), DORI_REVIEW_TIMEOUT_MIN: "1",
  };
  if (opts.backend) env["LANDING_BACKEND"] = JSON.stringify([join(fx.bin, "backend")]);
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** A real `dori review` against the fake reviewer writes the CLEAR/BLOCK receipt for the current fake head. */
async function reviewed(fx: Fixture, repo: string, verdict: "CLEAR" | "BLOCK" = "CLEAR") {
  writeFileSync(fx.f("verdict"), verdict);
  const r = await dori(fx, ["review", `${repo}#7`]);
  expect(r.stdout).toContain(`verdict=${verdict}`);
}

const receipt = (repo: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ repo, pr: 7, expectedHead: head, status: "queued", ...over });
const landed = (repo: string, over: Record<string, unknown> = {}) =>
  receipt(repo, { status: "landed", landedHead, landedTree, receipt: "queue-receipt-1", ...over });

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
    ["landed with only candidate fields", landed(NATIVE, { landedHead: undefined, landedTree: undefined, candidateHead: landedHead, candidateTree: landedTree }), 0],
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

  test.each([false, true])("dry-run never claims MERGE_OK from CLEAR alone (backend configured: %p)", async (backend) => {
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
  });
});

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
