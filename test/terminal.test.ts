import { describe, expect, test } from "bun:test";
import { HerdrCore } from "../src/herdr-core.ts";
import { CommandError, interactiveShellInFront, shq, type ExecResult } from "../src/terminal.ts";

describe("CommandError", () => {
  test("names the command and argv, and gives its own reason from stderr or else stdout", () => {
    const onStdout = new CommandError("hc", ["kill", "t7"], { code: 3, stdout: '{"error":{"kind":"not_found"}}\n', stderr: "" });
    expect(onStdout.message).toBe('hc kill t7 failed (3): {"error":{"kind":"not_found"}}');
    expect(onStdout.argv).toEqual(["kill", "t7"]);
    expect(onStdout.result.code).toBe(3);
    const onStderr = new CommandError("hc", ["read", "t7"], { code: 1, stdout: "partial", stderr: "socket closed\n" });
    expect(onStderr.message).toBe("hc read t7 failed (1): socket closed");
  });

  test("HerdrCore throws it for a failed hc call, named after the binary", async () => {
    const reply: ExecResult = { code: 1, stdout: "", stderr: "server down" };
    const error = await new HerdrCore(async () => reply, "/opt/bin/hc").close("t7").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).message).toBe("hc kill t7 failed (1): server down");
  });
});

describe("shq", () => {
  test("a quoted word reaches a real shell unchanged, single quotes and $ included", async () => {
    for (const s of ["plain", "two words", "it's", "''", "$HOME `id` $(echo x)", "back\\slash", "new\nline", ""]) {
      const proc = Bun.spawn(["sh", "-c", `printf %s ${shq(s)}`], { stdout: "pipe" });
      expect(await new Response(proc.stdout).text()).toBe(s);
    }
  });
});

describe("interactiveShellInFront (#66: a suspended agent leaves its shell in front)", () => {
  const front = (...procs: { name?: string; argv?: string[] }[]) => interactiveShellInFront({ foreground_processes: procs });
  test.each([
    ["login shell", [{ name: "-bash", argv: ["-bash"] }], true],
    ["interactive zsh by path, upper case", [{ name: "/bin/ZSH", argv: ["/bin/zsh", "-i"] }], true],
    ["bash -C (noclobber) is still interactive", [{ name: "bash", argv: ["bash", "-C"] }], true],
    ["busybox sh applet", [{ name: "busybox", argv: ["busybox", "sh"] }], true],
    ["shell entry without argv", [{ name: "fish" }], true],
    ["agent with a sh -c child", [{ name: "omo", argv: ["omo"] }, { name: "sh", argv: ["sh", "-c", "sleep 1"] }], false],
    ["shell running a script is held, the safe side", [{ name: "bash", argv: ["bash", "tool.sh"] }], true],
    ["interactive bash with --rcfile FILE", [{ name: "bash", argv: ["bash", "--rcfile", "/tmp/rc"] }], true],
    ["interactive zsh with -o OPT", [{ name: "zsh", argv: ["zsh", "-o", "vi"] }], true],
    ["login shell running a command: -lc", [{ name: "bash", argv: ["bash", "-lc", "make"] }], false],
    ["pwsh -File", [{ name: "pwsh", argv: ["pwsh", "-File", "x.ps1"] }], false],
    ["bash -f (noglob) is still interactive", [{ name: "bash", argv: ["bash", "-f"] }], true],
    ["bash --init-file F", [{ name: "bash", argv: ["bash", "--init-file", "/tmp/rc"] }], true],
    ["fish -C cmd (init command, still interactive)", [{ name: "fish", argv: ["fish", "-C", "set x 1"] }], true],
    ["bash -ic cmd runs a command", [{ name: "bash", argv: ["bash", "-ic", "make"] }], false],
    ["pwsh -EncodedCommand", [{ name: "pwsh", argv: ["pwsh", "-EncodedCommand", "ZQBjAGgAbwA="] }], false],
    ["pwsh -Interactive", [{ name: "pwsh", argv: ["pwsh", "-Interactive"] }], true],
    ["pwsh -NoProfile -ExecutionPolicy Bypass", [{ name: "pwsh", argv: ["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass"] }], true],
    ["pwsh -NoExit -Command keeps a prompt", [{ name: "pwsh", argv: ["pwsh", "-NoExit", "-Command", "ls"] }], true],
    ["pwsh -noex -c keeps a prompt", [{ name: "pwsh", argv: ["pwsh", "-noex", "-c", "ls"] }], true],
    ["pwsh --noexi -Command keeps a prompt", [{ name: "pwsh", argv: ["pwsh", "--noexi", "-Command", "ls"] }], true],
    ["powershell -c", [{ name: "powershell", argv: ["powershell", "-c", "ls"] }], false],
    ["pwsh -Command", [{ name: "pwsh", argv: ["pwsh", "-Command", "ls"] }], false],
    ["exec'd agent", [{ name: "bun", argv: ["bun", "omo.js"] }], false],
  ] as const)("%s", (_, procs, want) => {
    expect(front(...(procs as unknown as { name?: string; argv?: string[] }[]))).toBe(want);
  });
  test("an empty or missing process list is doubt", () => {
    expect(interactiveShellInFront({ foreground_processes: [] })).toBe(true);
    expect(interactiveShellInFront({})).toBe(true);
    expect(interactiveShellInFront(undefined)).toBe(true);
  });
});
