import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExec, ToolError } from "../src/runtime/exec.ts";
import { groupId } from "../src/runtime/group.ts";

describe("groupId", () => {
  test("is 8 lowercase hex chars and stable for one store root", () => {
    const id = groupId("/some/dori/home");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(groupId("/some/dori/home")).toBe(id);
  });

  test("hashes the resolved path: relative and trailing-slash spellings agree, other roots differ", () => {
    expect(groupId("/some/dori/home/")).toBe(groupId("/some/dori/home"));
    expect(groupId("/some/dori/./home")).toBe(groupId("/some/dori/home"));
    expect(groupId(".")).toBe(groupId(process.cwd()));
    expect(groupId("/other/home")).not.toBe(groupId("/some/dori/home"));
  });

  test("a symlinked store root shares the target's group", () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-group-"));
    symlinkSync(dir, `${dir}-link`);
    expect(groupId(`${dir}-link`)).toBe(groupId(dir));
  });
});

describe("exec", () => {
  test("ToolError names the tool, argv, exit code and the tool's own reason", () => {
    const err = new ToolError(["get", "t7"], { code: 3, stdout: "out", stderr: " not found \n" }, "hc");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("hc get t7 failed (3): not found");
    expect(err.argv).toEqual(["get", "t7"]);
    expect(err.result.code).toBe(3);
    expect(new ToolError(["x"], { code: 1, stdout: "from stdout", stderr: "" }, "gh").message).toBe(
      "gh x failed (1): from stdout",
    );
  });

  test("spawnExec returns code, stdout and stderr of a real process", async () => {
    const r = await spawnExec("sh", ["-c", "printf out; printf err >&2; exit 4"]);
    expect(r).toEqual({ code: 4, stdout: "out", stderr: "err" });
  });

  // The timeout itself is the behavior here, so this test runs real processes against a short deadline.
  test("spawnExec kills a command and its children at its timeout and says so; one that finishes in time is not marked", async () => {
    const started = Date.now();
    // The sleep is a child that holds stdout open, as an agent's own tools do; killing only the shell would hang here.
    const slow = await spawnExec("/bin/sh", ["-c", "echo partial; sleep 30; echo never"], { timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    expect(slow.stdout).toBe("partial\n");
    expect(Date.now() - started).toBeLessThan(10_000);
    const quick = await spawnExec("/bin/sh", ["-c", "echo done"], { timeoutMs: 10_000 });
    expect(quick).toEqual({ code: 0, stdout: "done\n", stderr: "" });
  });
});
