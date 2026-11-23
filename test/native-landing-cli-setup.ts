import { expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Drives the real src/cli.ts as a subprocess. gh, the omo reviewer and the landing queue are process fakes on a
// private PATH; every invocation is logged so tests can prove what was (not) called.
export const cli = resolve(import.meta.dir, "../src/cli.ts");
export const NATIVE = "formaengine/forma-rs";
export const GENERIC = "o/r";
export const head = "a".repeat(40);
export const moved = "d".repeat(40);
export const landedHead = "b".repeat(40);
export const landedTree = "c".repeat(40);
export const GREEN = '[{"name":"build","bucket":"pass"}]';
export const SKIPPED = '[{"name":"build","bucket":"skipping"}]';

export type Fixture = ReturnType<typeof sandbox>;
const roots: string[] = [];
/** Removes every sandbox made so far; each test file registers it with afterEach. */
export const cleanup = (): void => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
};

export function script(path: string, body: string): void {
  writeFileSync(
    path,
    `#!${process.execPath}\nimport { appendFileSync, readFileSync, existsSync } from "node:fs";\n${body}`,
  );
  chmodSync(path, 0o755);
}

export function sandbox() {
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
  script(
    join(bin, "gh"),
    `
export const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(f("gh.jsonl"))}, JSON.stringify(argv) + "\\n");
if (argv[0] === "pr" && argv[1] === "view") {
  console.log(JSON.stringify({ headRefOid: readFileSync(${JSON.stringify(f("head"))}, "utf8") }));
} else if (argv[0] === "pr" && argv[1] === "checks") {
  process.stdout.write(readFileSync(${JSON.stringify(f("checks"))}, "utf8"));
} else if (argv[0] === "pr" && argv[1] === "merge") {
  appendFileSync(${JSON.stringify(f("merge.jsonl"))}, JSON.stringify(argv) + "\\n");
} else { console.error("sandbox gh refuses " + argv.join(" ")); process.exit(91); }
`,
  );
  script(
    join(bin, "agent"),
    `
console.log("review text\\nVERDICT: " + readFileSync(${JSON.stringify(f("verdict"))}, "utf8"));
`,
  );
  script(
    join(bin, "backend"),
    `
appendFileSync(${JSON.stringify(f("backend.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(readFileSync(${JSON.stringify(f("backend-out"))}, "utf8"));
process.exit(Number(readFileSync(${JSON.stringify(f("backend-code"))}, "utf8")));
`,
  );
  return { root, bin, home, f };
}

export const lines = (path: string): string[][] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
export const merges = (fx: Fixture) => lines(fx.f("merge.jsonl"));
export const backendCalls = (fx: Fixture) => lines(fx.f("backend.jsonl"));

export async function dori(fx: Fixture, args: string[], opts: { backend?: boolean } = {}) {
  const env: Record<string, string> = {
    PATH: fx.bin,
    HOME: fx.root,
    DORI_HOME: fx.home,
    DORI_TELEMETRY: "0",
    DORI_AGENT_CMD: join(fx.bin, "agent"),
    DORI_REVIEW_TIMEOUT_MIN: "1",
  };
  if (opts.backend) env["LANDING_BACKEND"] = JSON.stringify([join(fx.bin, "backend")]);
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** A real `dori review` against the fake reviewer writes the CLEAR/BLOCK receipt for the current fake head. */
export async function reviewed(fx: Fixture, repo: string, verdict: "CLEAR" | "BLOCK" = "CLEAR") {
  writeFileSync(fx.f("verdict"), verdict);
  const r = await dori(fx, ["review", `${repo}#7`]);
  expect(r.stdout).toContain(`verdict=${verdict}`);
}

export const receipt = (repo: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ repo, pr: 7, expectedHead: head, status: "queued", ...over });
export const landed = (repo: string, over: Record<string, unknown> = {}) =>
  receipt(repo, { status: "landed", landedHead, landedTree, receipt: "queue-receipt-1", ...over });
