import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { parseSync } from "oxc-parser";

// The landmines testing rules in scripts/oxlint/ (each file's header names its origin and license), ratcheted per
// file: each file's count must match the baseline exactly. A rise fails, and so does a drop until the baseline is
// lowered in the same change, so a removed site cannot come back. Biome stays the repository's linter; oxlint runs
// here only as the carrier for these rules, with scripts/lint-ratchet.oxlintrc.json and nothing else enabled.
export const RATCHET_RULES = [
  "dori-testing/no-fixed-sleep",
  "dori-testing/no-flake-masking",
  "dori-testing/no-module-mock",
] as const;

// A disable comment hides a finding from the linter, so it is counted as an extra value: one that
// names one of the ratcheted rules, or a bare one that turns every rule off for its line or file.
export const SUPPRESSION = "disable-directive";
// A directive is a comment whose text starts with the directive word, as oxlint reads it. The
// comments come from the parser, so a directive inside a string or template never counts.
const DIRECTIVE = /^[\s*]*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?:\s|$)([\s\S]*)$/;
const NAMES_A_RULE = /\b(?:no-fixed-sleep|no-flake-masking|no-module-mock)\b/;

export const countSuppressions = (file: string, source: string): number => {
  let count = 0;
  for (const comment of parseSync(file, source).comments) {
    const rest = DIRECTIVE.exec(comment.value)?.[1] ?? null;
    if (rest === null) continue;
    const list = rest.split("--")[0]?.trim() ?? "";
    if (list === "" || NAMES_A_RULE.test(list)) count += 1;
  }
  return count;
};

export type Counts = Readonly<Record<string, Readonly<Record<string, number>>>>;

type Diagnostic = {
  readonly code?: string | null;
  readonly filename: string;
  readonly message?: string;
};

const ruleOf = (code: string): string => code.replace(/^([a-z-]+)\(([a-z-]+)\)$/, "$1/$2");

export const countByFile = (diagnostics: readonly (Diagnostic & { readonly code: string })[], root: string): Counts => {
  const counts: Record<string, Record<string, number>> = {};
  for (const { code, filename } of diagnostics) {
    const file = relative(root, resolve(root, filename)).split(sep).join("/");
    const rule = ruleOf(code);
    const perFile = counts[file] ?? {};
    perFile[rule] = (perFile[rule] ?? 0) + 1;
    counts[file] = perFile;
  }
  return counts;
};

export type Change = {
  readonly file: string;
  readonly rule: string;
  readonly before: number;
  readonly after: number;
};

export const compare = (baseline: Counts, current: Counts) => {
  const increases: Change[] = [];
  const decreases: Change[] = [];
  const files = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const file of [...files].toSorted()) {
    for (const rule of [...RATCHET_RULES, SUPPRESSION]) {
      const before = baseline[file]?.[rule] ?? 0;
      const after = current[file]?.[rule] ?? 0;
      if (after > before) increases.push({ file, rule, before, after });
      if (after < before) decreases.push({ file, rule, before, after });
    }
  }
  return { increases, decreases };
};

const sorted = (counts: Counts): Counts =>
  Object.fromEntries(
    Object.keys(counts)
      .toSorted()
      .map((file) => [
        file,
        Object.fromEntries(Object.entries(counts[file] ?? {}).toSorted(([a], [b]) => a.localeCompare(b))),
      ]),
  );

// The tracked JS/TS sources.
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
export const ratchetedFiles = (files: readonly string[]): string[] => files.filter((file) => SOURCE.test(file));

const CONFIG = "scripts/lint-ratchet.oxlintrc.json";

const run = (root: string, command: string, args: readonly string[]) =>
  spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

// A diagnostic with no rule code is a parse error: that file's findings cannot be counted. A file
// oxlint was given but did not lint (`skipped`) cannot be counted either.
type Lint = { readonly counts: Counts; readonly unparsed: readonly string[]; readonly skipped: number };

export const lint = (root: string): Lint => {
  const listed = run(root, "git", ["ls-files", "-z"]);
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const files = ratchetedFiles(listed.stdout.split("\0")).filter((file) => existsSync(join(root, file)));
  const diagnostics: Diagnostic[] = [];
  let skipped = 0;
  // Batches keep each argv under the OS limit.
  for (let start = 0; start < files.length; start += 2000) {
    const batch = files.slice(start, start + 2000);
    const result = run(root, join(root, "node_modules/.bin/oxlint"), [
      "-c",
      CONFIG,
      // No ignore file (.eslintignore, --ignore-path) may hide a tracked file from the count:
      // ratchetedFiles is the only exclusion.
      "--no-ignore",
      "--format",
      "json",
      ...batch,
    ]);
    if (result.error !== undefined || (result.status !== 0 && result.status !== 1))
      throw new Error(`oxlint failed (status ${String(result.status)}): ${result.stderr}`);
    const parsed: { readonly diagnostics: readonly Diagnostic[]; readonly number_of_files: number } = JSON.parse(
      result.stdout,
    );
    diagnostics.push(...parsed.diagnostics);
    // --no-ignore does not reach a config's ignorePatterns, so a file oxlint skips is caught here.
    skipped += batch.length - parsed.number_of_files;
  }
  const ruled = diagnostics.flatMap((diagnostic) =>
    typeof diagnostic.code === "string" ? [{ ...diagnostic, code: diagnostic.code }] : [],
  );
  const unparsed = diagnostics
    .filter((diagnostic) => typeof diagnostic.code !== "string")
    .map((diagnostic) => `${diagnostic.filename}: ${diagnostic.message ?? "parse error"}`);
  const counts: Record<string, Record<string, number>> = { ...countByFile(ruled, root) };
  for (const file of files) {
    const count = countSuppressions(file, readFileSync(join(root, file), "utf8"));
    if (count > 0) counts[file] = { ...counts[file], [SUPPRESSION]: count };
  }
  return { counts, unparsed, skipped };
};

const main = () => {
  const root = resolve(import.meta.dirname, "..");
  const baselinePath = join(root, "scripts/lint-ratchet.baseline.json");
  const { counts: current, unparsed, skipped } = lint(root);
  if (unparsed.length > 0) {
    for (const line of unparsed) console.error(line);
    console.error("lint-ratchet: a file that fails to parse cannot be counted; fix the syntax first.");
    process.exit(1);
  }
  if (skipped > 0) {
    console.error(
      `lint-ratchet: oxlint skipped ${skipped} tracked file(s), so their counts would drop silently; remove the ignorePatterns entry and exclude files in ratchetedFiles instead.`,
    );
    process.exit(1);
  }
  if (process.argv.includes("--update")) {
    // Lowering is the only routine update: raising a count needs the explicit flag, so following
    // the "lower the baseline" advice can never also lock in new findings.
    if (existsSync(baselinePath) && !process.argv.includes("--allow-increase")) {
      const { increases } = compare(JSON.parse(readFileSync(baselinePath, "utf8")), current);
      for (const { file, rule, before, after } of increases)
        console.error(`${file}: ${rule} went up from ${before} to ${after}`);
      if (increases.length > 0) {
        console.error("lint-ratchet: --update only lowers counts; fix the new findings (or pass --allow-increase).");
        process.exit(1);
      }
    }
    writeFileSync(baselinePath, `${JSON.stringify(sorted(current), null, 2)}\n`);
    console.log(`lint-ratchet: baseline written for ${Object.keys(current).length} files`);
    return;
  }
  const baseline: Counts = JSON.parse(readFileSync(baselinePath, "utf8"));
  const { increases, decreases } = compare(baseline, current);
  for (const { file, rule, before, after } of increases)
    console.error(`${file}: ${rule} went up from ${before} to ${after}`);
  for (const { file, rule, before, after } of decreases)
    console.error(`${file}: ${rule} went down from ${before} to ${after}; lower the baseline in this change`);
  if (increases.length > 0)
    console.error(`lint-ratchet: new code must not add ${RATCHET_RULES.join(", ")} or a disable comment for them.`);
  if (decreases.length > 0 && increases.length === 0)
    console.error(
      "lint-ratchet: run `bun run lint:ratchet:update` and commit the baseline, so removed sites cannot come back.",
    );
  if (increases.length > 0 || decreases.length > 0) process.exit(1);
  console.log("lint-ratchet: every count matches the baseline");
};

if (import.meta.main) main();
