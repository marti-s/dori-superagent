import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const root = join(import.meta.dir, "../..");

export type Finding = { readonly code: string; readonly message: string };

type Diagnostic = { readonly code?: string; readonly message?: string; readonly filename: string };

// Lints every fixture through the shipped ratchet configuration (so losing its jsPlugins entry fails too) in ONE
// oxlint run, and returns each fixture's findings in input order. Fixtures are written to the OS temp root, outside
// the repository, so no repo-side scan can meet them.
export const lintFixtures = (sources: readonly string[]): Finding[][] => {
  const dir = mkdtempSync(join(tmpdir(), "dori-testing-rules-"));
  try {
    const files = sources.map((source, index) => {
      const file = join(dir, `case-${index}.test.ts`);
      writeFileSync(file, source);
      return file;
    });
    const result = Bun.spawnSync(
      [join(root, "node_modules/.bin/oxlint"), "-c", "scripts/lint-ratchet.oxlintrc.json", "-f", "json", ...files],
      { cwd: root },
    );
    if (result.exitCode !== 0 && result.exitCode !== 1)
      throw new Error(`oxlint failed (${result.exitCode}): ${result.stderr.toString()}`);
    const { diagnostics }: { readonly diagnostics: readonly Diagnostic[] } = JSON.parse(result.stdout.toString());
    const byFile = files.map((): Finding[] => []);
    for (const { code, message, filename } of diagnostics) {
      const found = byFile[Number(/^case-(\d+)\.test\.ts$/.exec(basename(filename))?.[1])];
      if (found === undefined) throw new Error(`unexpected diagnostic file ${filename}`);
      found.push({ code: code ?? "parse-error", message: message ?? "" });
    }
    return byFile;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
