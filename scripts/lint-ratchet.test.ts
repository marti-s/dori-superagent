import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compare, countByFile, countSuppressions, lint, ratchetedFiles, SUPPRESSION } from "./lint-ratchet.ts";

const root = "/repo";
const sleep = "dori-testing/no-fixed-sleep";
const flake = "dori-testing/no-flake-masking";
const moduleMock = "dori-testing/no-module-mock";

describe("lint ratchet", () => {
  it("counts findings per file and rule, relative to the repo root", () => {
    const counts = countByFile(
      [
        { code: "dori-testing(no-module-mock)", filename: "src/a.test.ts" },
        { code: "dori-testing(no-module-mock)", filename: "/repo/src/a.test.ts" },
        { code: "dori-testing(no-fixed-sleep)", filename: "src/a.test.ts" },
        { code: "dori-testing(no-flake-masking)", filename: "scripts/b.test.ts" },
      ],
      root,
    );
    expect(counts).toEqual({
      "src/a.test.ts": { [moduleMock]: 2, [sleep]: 1 },
      "scripts/b.test.ts": { [flake]: 1 },
    });
  });

  it("refuses a count that goes up, including any finding in a file the baseline does not list", () => {
    const { increases } = compare(
      { "src/a.test.ts": { [moduleMock]: 2 } },
      { "src/a.test.ts": { [moduleMock]: 3 }, "src/new.test.ts": { [sleep]: 1 } },
    );
    expect(increases).toEqual([
      { file: "src/a.test.ts", rule: moduleMock, before: 2, after: 3 },
      { file: "src/new.test.ts", rule: sleep, before: 0, after: 1 },
    ]);
  });

  it("reports a count that goes down, so the baseline must be lowered in the same change", () => {
    const { increases, decreases } = compare(
      { "src/a.test.ts": { [flake]: 2 }, "src/gone.test.ts": { [moduleMock]: 1 } },
      { "src/a.test.ts": { [flake]: 2 } },
    );
    expect(increases).toEqual([]);
    expect(decreases).toEqual([{ file: "src/gone.test.ts", rule: moduleMock, before: 1, after: 0 }]);
  });

  it("accepts counts that match the baseline exactly", () => {
    const counts = { "src/a.test.ts": { [flake]: 2 } };
    expect(compare(counts, counts)).toEqual({ increases: [], decreases: [] });
  });

  it("counts every disable comment that names a ratcheted rule or disables every rule", () => {
    // Built at runtime so this file holds no directive of its own for the gate to count.
    const line = "/".repeat(2);
    const block = ["/", "*"].join("");
    const source = [
      `${line} oxlint-disable-next-line dori-testing/no-fixed-sleep`,
      `${line} eslint-disable-next-line dori-testing/no-flake-masking -- legacy`,
      `${block} eslint-disable */`,
      `const a = 1; ${line} oxlint-disable-line`,
      `${line} oxlint-disable-next-line dori-testing/no-module-mock, eslint/no-console`,
      `${line} oxlint-disable-next-line eslint/no-console -- unrelated rule, not counted`,
      `const text = "oxlint-disable-next-line dori-testing/no-module-mock";`,
      `${block}\n  eslint-disable-next-line dori-testing/no-module-mock\n*/`,
    ].join("\n");
    expect(countSuppressions("probe.ts", source)).toBe(6);
    expect(countSuppressions("probe.ts", "const x = 1;\n")).toBe(0);
  });

  it("refuses a new disable comment like any other rise", () => {
    const { increases } = compare({}, { "scripts/probe.ts": { [SUPPRESSION]: 1 } });
    expect(increases).toEqual([{ file: "scripts/probe.ts", rule: SUPPRESSION, before: 0, after: 1 }]);
  });

  it("ratchets only JS/TS sources", () => {
    expect(ratchetedFiles(["src/a.ts", "src/b.mjs", "README.md", "package.json"])).toEqual(["src/a.ts", "src/b.mjs"]);
  });
});

// The ratchet's real oxlint run, in a scratch repo that reuses this repo's oxlint and plugin. A config's
// ignorePatterns resolve inside its own directory, so the hidden file sits in scripts/ next to it.
describe("lint ratchet ignore files", () => {
  const scratch = mkdtempSync(join(tmpdir(), "lint-ratchet-ignore-"));
  const config = join(scratch, "scripts/lint-ratchet.oxlintrc.json");
  let listedInEslintignore: ReturnType<typeof lint>;
  let hiddenByIgnorePatterns: ReturnType<typeof lint>;

  beforeAll(() => {
    const repo = join(import.meta.dir, "..");
    const shipped = JSON.parse(readFileSync(join(repo, "scripts/lint-ratchet.oxlintrc.json"), "utf8"));
    symlinkSync(join(repo, "node_modules"), join(scratch, "node_modules"));
    mkdirSync(join(scratch, "scripts"));
    symlinkSync(join(repo, "scripts/oxlint"), join(scratch, "scripts/oxlint"));
    writeFileSync(config, JSON.stringify(shipped));
    writeFileSync(
      join(scratch, "scripts/hidden.test.ts"),
      'import { mock } from "bun:test";\nmock.module("./dep", () => ({}));\n',
    );
    writeFileSync(join(scratch, "clean.ts"), "export const clean = 1;\n");
    writeFileSync(join(scratch, ".eslintignore"), "scripts/hidden.test.ts\n");
    execFileSync("git", ["init", "-q"], { cwd: scratch });
    execFileSync("git", ["add", "."], { cwd: scratch });
    listedInEslintignore = lint(scratch);
    writeFileSync(config, JSON.stringify({ ...shipped, ignorePatterns: ["hidden.test.ts"] }));
    hiddenByIgnorePatterns = lint(scratch);
  }, 60_000);

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("still counts a violating file that .eslintignore lists", () => {
    expect(listedInEslintignore).toEqual({
      counts: { "scripts/hidden.test.ts": { [moduleMock]: 1 } },
      unparsed: [],
      skipped: 0,
    });
  });

  it("reports a file hidden by the ratchet config ignorePatterns as skipped, not as zero findings", () => {
    expect(hiddenByIgnorePatterns).toEqual({ counts: {}, unparsed: [], skipped: 1 });
  });
});
