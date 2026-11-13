import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const harness = resolve(import.meta.dir, "../src/harness.ts");

test.each(["", "not json", "null", "{}", "[]", '"backend"', '[""]', '["backend", ""]', '["backend", 3]', '["   "]'])(
  "CLI refuses invalid LANDING_BACKEND %j before any command",
  async (raw) => {
    const home = mkdtempSync(join(tmpdir(), "dori-landing-config-"));
    try {
      const child = Bun.spawn([process.execPath, cli, "status"], {
        env: { ...process.env, DORI_HOME: home, DORI_TELEMETRY: "0", LANDING_BACKEND: raw },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(code).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toContain("LANDING_BACKEND");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test.each([undefined, '["/queue backend","submit","$(literal); argument"]'])(
  "defaultDeps parses landing argv once with config %j",
  async (raw) => {
    const home = mkdtempSync(join(tmpdir(), "dori-landing-config-"));
    const env: NodeJS.ProcessEnv = { ...process.env, DORI_HOME: home, DORI_TELEMETRY: "0" };
    delete env.LANDING_BACKEND;
    if (raw !== undefined) env.LANDING_BACKEND = raw;
    try {
      const child = Bun.spawn([process.execPath, "-e", `
        import { defaultDeps } from ${JSON.stringify(harness)};
        const d = defaultDeps();
        process.env.LANDING_BACKEND = '["changed"]';
        console.log(JSON.stringify(d.landingBackend ?? null));
      `], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual(raw === undefined ? null : JSON.parse(raw));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
