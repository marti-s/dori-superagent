import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanup,
  type Fixture,
  dori,
  refused,
  repo,
  reviewed,
  run,
  sandbox,
  tuple,
} from "./native-bootstrap-cli-setup.ts";

afterEach(cleanup);

const invalidSources: readonly [string, (fx: Fixture) => void | Promise<unknown>, { code: number; reason: string }?][] =
  [
    ["wrong tuple head", (fx) => tuple(fx, { head: fx.base })],
    ["wrong tuple tree", (fx) => tuple(fx, { tree: "b".repeat(40) })],
    ["wrong tuple repo", (fx) => tuple(fx, { repo: "other/repo" })],
    ["wrong tuple PR", (fx) => tuple(fx, { pr: 8 })],
    [
      "short tuple head",
      (fx) => tuple(fx, { head: fx.head.slice(0, 12) }),
      { code: 1, reason: "FORMA_QUEUE_BOOTSTRAP must be JSON exactly" },
    ],
    [
      "short tuple tree",
      (fx) => tuple(fx, { tree: fx.tree.slice(0, 12) }),
      { code: 1, reason: "FORMA_QUEUE_BOOTSTRAP must be JSON exactly" },
    ],
    [
      "extra bootstrap field",
      (fx) => tuple(fx, { source: fx.source }),
      { code: 1, reason: "FORMA_QUEUE_BOOTSTRAP must be JSON exactly" },
    ],
    [
      "missing bootstrap tuple",
      (fx) => {
        delete fx.env["FORMA_QUEUE_BOOTSTRAP"];
      },
    ],
    [
      "missing tuple with absolute Python entry",
      (fx) => {
        delete fx.env["FORMA_QUEUE_BOOTSTRAP"];
        const python = Bun.which("python3");
        if (!python) throw new Error("CLI sandbox requires python3");
        fx.env["LANDING_BACKEND"] = JSON.stringify([python, fx.entry]);
      },
    ],
    [
      "missing tuple with a prefixed adapter",
      (fx) => {
        delete fx.env["FORMA_QUEUE_BOOTSTRAP"];
        fx.env["LANDING_BACKEND"] = JSON.stringify(["/usr/bin/env", "python3", fx.entry]);
      },
    ],
    [
      "missing tuple with a relative prefixed adapter",
      (fx) => {
        delete fx.env["FORMA_QUEUE_BOOTSTRAP"];
        fx.env["LANDING_BACKEND"] = JSON.stringify([
          "/usr/bin/env",
          "python3",
          ".agents/workflows/landing-verifier.py",
        ]);
      },
    ],
    [
      "missing tuple with a normalized prefixed adapter",
      (fx) => {
        delete fx.env["FORMA_QUEUE_BOOTSTRAP"];
        fx.env["LANDING_BACKEND"] = JSON.stringify([
          "/usr/bin/env",
          "python3",
          ".agents/workflows/./landing-verifier.py",
        ]);
      },
    ],
    [
      "source HEAD differs from requested head",
      (fx) => {
        writeFileSync(join(fx.root, "head"), fx.base);
        tuple(fx, { head: fx.base });
      },
    ],
    [
      "tracked sibling dirt",
      (fx) => {
        appendFileSync(join(fx.workflows, "caller_sibling.py"), "# dirty\n");
      },
    ],
    [
      "untracked sibling",
      (fx) => {
        writeFileSync(join(fx.workflows, "new_sibling.py"), "untrusted = True\n");
      },
    ],
    [
      "ignored importable source",
      (fx) => {
        writeFileSync(join(fx.workflows, "ignored_module.py"), "untrusted = True\n");
      },
    ],
    [
      "ignored importable extension",
      (fx) => {
        writeFileSync(join(fx.workflows, "ignored_module.so"), "untrusted");
      },
    ],
    [
      "ignored real Python cache",
      async (fx) => {
        const result = await run(
          [
            "python3",
            "-I",
            "-S",
            "-B",
            "-c",
            "import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True)",
            join(fx.workflows, "caller_sibling.py"),
          ],
          fx.root,
          fx.env,
        );
        expect(result.code, result.stderr).toBe(0);
      },
    ],
    ["wrong source origin", (fx) => fx.git("remote", "set-url", "origin", "https://github.com/other/repo.git")],
    [
      "nonancestor fresh main despite stale local tracking ref",
      async (fx) => {
        const tree = await fx.git("rev-parse", `${fx.base}^{tree}`);
        const fresh = await fx.git("commit-tree", tree, "-p", fx.base, "-m", "Divergent fresh main");
        await fx.git("push", "origin", `${fresh}:refs/heads/main`);
        await fx.git("update-ref", "refs/remotes/origin/main", fx.base);
      },
    ],
    [
      "arbitrary Python entry",
      (fx) => {
        fx.env["LANDING_BACKEND"] = JSON.stringify(["python3", join(fx.workflows, "arbitrary.py")]);
      },
    ],
    [
      "arbitrary executable entry",
      (fx) => {
        fx.env["LANDING_BACKEND"] = JSON.stringify([join(fx.root, "bin/arbitrary")]);
      },
    ],
  ];

describe("native caller bootstrap through the real CLI", () => {
  test.each(
    invalidSources.map(
      ([name, change, expected]) => [name, change, expected ?? { code: 2, reason: "MERGE_REFUSED" }] as const,
    ),
  )("refuses %s before imported sibling execution", async (_name, change, expected) => {
    const fx = await sandbox();
    await change(fx);
    await reviewed(fx);

    const result = await dori(fx, ["merge", `${repo}#7`]);

    refused(fx, result, expected);
    expect(result.stderr).toMatch(/bootstrap|source|canonical|backend/i);
  });

  test("clean pinned source executes isolated Python and queues without hostile imports", async () => {
    const fx = await sandbox();
    const poison = join(fx.root, "poison");
    const userSite = await run(["python3", "-c", "import site; print(site.getusersitepackages())"], fx.root, {
      ...fx.env,
      PYTHONUSERBASE: join(fx.root, "user"),
    });
    expect(userSite.code, userSite.stderr).toBe(0);
    mkdirSync(userSite.stdout.trim(), { recursive: true });
    const attack = `from pathlib import Path\nPath(${JSON.stringify(fx.hostile)}).write_text("hostile import")\nraise RuntimeError("hostile Python root executed")\n`;
    for (const dir of [poison, userSite.stdout.trim()]) {
      for (const name of ["caller_sibling.py", "sitecustomize.py", "usercustomize.py"])
        writeFileSync(join(dir, name), attack);
    }
    Object.assign(fx.env, { PYTHONPATH: poison, PYTHONUSERBASE: join(fx.root, "user"), PYTHONHOME: poison });
    await reviewed(fx);

    const result = await dori(fx, ["merge", `${repo}#7`]);

    expect(result).toEqual({ code: 0, stdout: `QUEUED ${repo}#7 head=${fx.head}\n`, stderr: "" });
    expect(readFileSync(fx.sentinel, "utf8")).toBe("trusted sibling");
    expect(JSON.parse(readFileSync(fx.execution, "utf8"))).toEqual({
      isolated: 1,
      no_site: 1,
      dont_write_bytecode: 1,
      ignore_environment: 1,
      no_user_site: 1,
    });
    expect(existsSync(fx.hostile)).toBe(false);
    expect(existsSync(join(fx.root, "direct-merge"))).toBe(false);
    expect(await fx.git("status", "--porcelain", "--ignored")).toBe("");
  });

  test("native admission without a backend refuses before imports", async () => {
    const fx = await sandbox();
    await reviewed(fx);
    delete fx.env["LANDING_BACKEND"];

    const result = await dori(fx, ["merge", `${repo}#7`]);

    refused(fx, result);
  });

  test.each(["missing", "BLOCK", "stale"])("requires exact-head CLEAR when review is %s", async (review) => {
    const fx = await sandbox();
    if (review !== "missing") {
      writeFileSync(join(fx.root, "verdict"), review === "BLOCK" ? "BLOCK" : "CLEAR");
      const result = await dori(fx, ["review", `${repo}#7`]);
      expect(result.code, result.stderr).toBe(review === "BLOCK" ? 1 : 0);
      if (review === "stale") writeFileSync(join(fx.root, "head"), fx.base);
    }

    const result = await dori(fx, ["merge", `${repo}#7`]);

    refused(fx, result);
  });
});
