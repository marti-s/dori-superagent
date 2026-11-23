import { describe, expect, test } from "bun:test";
import { interactiveShellInFront, SHELLS } from "../src/runtime/foreground.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import type { CreateSpec, ForegroundProcess, RuntimeKind, SessionRef, SessionRuntime } from "../src/runtime/types.ts";
import { formatRef, openSession, parseRef } from "../src/runtime/types.ts";

describe("parseRef / formatRef", () => {
  test.each([
    ["hc:t7", { runtime: "hc", id: "t7" }],
    ["t7", { runtime: "hc", id: "t7" }],
    ["hc:t12", { runtime: "hc", id: "t12" }],
    ["hc:t2h", { runtime: "hc", id: "t2h" }],
    ["hc:t1b", { runtime: "hc", id: "t1b" }],
    ["t2h", { runtime: "hc", id: "t2h" }],
    ["t", undefined],
    ["", undefined],
    ["lead", undefined],
    ["tmux:t3", undefined],
    ["w1:p3", undefined],
    ["herdr:w1:p3", undefined],
    ["hc:w1:p3", undefined],
    ["hc:", undefined],
    ["hc:hc:t7", undefined],
    ["t3 ", undefined],
    ["machine/t7", undefined],
    ["hc:box-2/t2h", undefined],
    ["hc:T2H", undefined],
    ["T2H", undefined],
    ["hc:t2h-", undefined],
    ["hc:/t2h", undefined],
    ["hc:a/b/t2h", undefined],
  ] as const)("parseRef(%p)", (text, want) => {
    expect(parseRef(text)).toEqual(want);
  });

  test.each([
    ["hc:t7", { runtime: "hc", id: "t7" }],
    ["hc:t7 (group dropped)", { runtime: "hc", id: "t7", group: "abcd1234" }],
  ] as const)("formatRef gives %s and parses back", (want, ref) => {
    expect(formatRef(ref)).toBe(want.split(" ")[0] ?? "");
    expect(parseRef(formatRef(ref))).toEqual({ runtime: ref.runtime, id: ref.id });
  });
});

describe("interactiveShellInFront (#66)", () => {
  const p = (name: string, ...argv: string[]): ForegroundProcess => ({ name, argv });
  test.each([
    ["login shell", [p("-bash", "-bash")], true],
    ["interactive zsh by path, upper case", [p("/bin/ZSH", "/bin/zsh", "-i")], true],
    ["bash -C (noclobber) is still interactive", [p("bash", "bash", "-C")], true],
    ["busybox sh applet", [p("busybox", "busybox", "sh")], true],
    ["shell entry without argv", [p("fish")], true],
    ["agent with a sh -c child", [p("omo", "omo"), p("sh", "sh", "-c", "sleep 1")], false],
    ["shell running a script is held, the safe side", [p("bash", "bash", "tool.sh")], true],
    ["interactive bash with --rcfile FILE", [p("bash", "bash", "--rcfile", "/tmp/rc")], true],
    ["interactive zsh with -o OPT", [p("zsh", "zsh", "-o", "vi")], true],
    ["login shell running a command: -lc", [p("bash", "bash", "-lc", "make")], false],
    ["pwsh -File", [p("pwsh", "pwsh", "-File", "x.ps1")], false],
    ["bash -f (noglob) is still interactive", [p("bash", "bash", "-f")], true],
    ["bash --init-file F", [p("bash", "bash", "--init-file", "/tmp/rc")], true],
    ["fish -C cmd (init command, still interactive)", [p("fish", "fish", "-C", "set x 1")], true],
    ["bash -ic cmd runs a command", [p("bash", "bash", "-ic", "make")], false],
    ["pwsh -EncodedCommand", [p("pwsh", "pwsh", "-EncodedCommand", "ZQBjAGgAbwA=")], false],
    ["pwsh -Interactive", [p("pwsh", "pwsh", "-Interactive")], true],
    ["pwsh -NoProfile -ExecutionPolicy Bypass", [p("pwsh", "pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass")], true],
    ["pwsh -NoExit -Command keeps a prompt", [p("pwsh", "pwsh", "-NoExit", "-Command", "ls")], true],
    ["pwsh -noex -c keeps a prompt", [p("pwsh", "pwsh", "-noex", "-c", "ls")], true],
    ["pwsh --noexi -Command keeps a prompt", [p("pwsh", "pwsh", "--noexi", "-Command", "ls")], true],
    ["powershell -c", [p("powershell", "powershell", "-c", "ls")], false],
    ["pwsh -Command", [p("pwsh", "pwsh", "-Command", "ls")], false],
    ["exec'd agent", [p("bun", "bun", "omo.js")], false],
    ["busybox running a command applet: busybox sh -c", [p("busybox", "busybox", "sh", "-c", "x")], false],
    ["hc group leader only: an agent", [{ name: "omo", argv: ["omo"], pid: 4242 }], false],
    ["hc group leader only: a bare shell", [{ name: "bash", argv: ["bash"], pid: 4242 }], true],
  ] as const)("%s", (_, procs, want) => {
    expect(interactiveShellInFront(procs)).toBe(want);
  });

  test("an empty or missing process list is doubt", () => {
    expect(interactiveShellInFront([])).toBe(true);
    expect(interactiveShellInFront(undefined)).toBe(true);
  });

  test("SHELLS covers the busybox and PowerShell names", () => {
    for (const name of ["sh", "bash", "zsh", "fish", "busybox", "pwsh", "powershell"])
      expect(SHELLS.has(name)).toBe(true);
    expect(SHELLS.has("omo")).toBe(false);
  });
});

describe("Runtimes registry", () => {
  const fakeRuntime = (kind: RuntimeKind): SessionRuntime => {
    const never = (): never => {
      throw new Error("not used");
    };
    return {
      kind,
      self: () => undefined,
      create: never,
      start: never,
      list: never,
      probe: never,
      read: never,
      deliver: never,
      submitTyped: never,
      typeIntoShell: never,
      keys: never,
      close: never,
    };
  };
  const counting = () => {
    const made: RuntimeKind[] = [];
    const runtimes = new Runtimes("hc", (k) => {
      made.push(k);
      return fakeRuntime(k);
    });
    return { made, runtimes };
  };

  test("builds nothing until asked, then memoises one runtime per kind", () => {
    const { made, runtimes } = counting();
    expect(made).toEqual([]);
    const a = runtimes.default;
    const b = runtimes.default;
    expect(a).toBe(b);
    expect(a.kind).toBe("hc");
    expect(made).toEqual(["hc"]);
  });

  test("a stored ref is answered by the same runtime as the default, built once", () => {
    const { made, runtimes } = counting();
    const ref: SessionRef = { runtime: "hc", id: "t3" };
    expect(runtimes.for(ref).kind).toBe("hc");
    expect(runtimes.for(ref)).toBe(runtimes.default);
    expect(made).toEqual(["hc"]);
  });
});

describe("Runtimes.kinds and selfAny", () => {
  const make = () => new Runtimes("hc", (k) => ({ kind: k }) as unknown as SessionRuntime);

  test("kinds lists the runtimes built so far", () => {
    const runtimes = make();
    expect(runtimes.kinds()).toEqual([]);
    runtimes.for({ runtime: "hc", id: "t1" });
    runtimes.default;
    expect(runtimes.kinds()).toEqual(["hc"]);
  });

  test.each([
    ["an hc terminal", { HC_TERMINAL_ID: "t7" }, { runtime: "hc", id: "t7" }],
    ["an old herdr pane variable names no session", { HERDR_PANE_ID: "w1:p3", HERDR_WORKSPACE_ID: "w1" }, undefined],
    ["an empty variable is unset", { HC_TERMINAL_ID: "" }, undefined],
    ["outside any runtime", {}, undefined],
  ] as const)("selfAny: %s", (_, env, want) => {
    const runtimes = make();
    expect(runtimes.selfAny(env)).toEqual(want);
    expect(runtimes.kinds()).toEqual([]);
  });
});

describe("openSession", () => {
  test("creates the session, then starts the command in it, and returns the created ref", async () => {
    const calls: string[] = [];
    const ref: SessionRef = { runtime: "hc", id: "t9", group: "g" };
    const rt = {
      kind: "hc",
      create: async (spec: CreateSpec) => {
        calls.push(`create ${spec.name} ${spec.role}`);
        return ref;
      },
      start: async (r: SessionRef, command: string) => {
        calls.push(`start ${formatRef(r)} ${command}`);
      },
    } as unknown as SessionRuntime;
    const spec: CreateSpec = { name: "lane-a", cwd: "/w", env: {}, role: "lane" };
    expect(await openSession(rt, spec, "omo")).toBe(ref);
    expect(calls).toEqual(["create lane-a lane", "start hc:t9 omo"]);
  });

  test("a failed start closes the session it just created and rethrows the start error", async () => {
    const calls: string[] = [];
    const rt = {
      create: async () => ({ runtime: "hc", id: "t4" }) as SessionRef,
      start: async () => {
        calls.push("start");
        throw new Error("send refused");
      },
      close: async (r: SessionRef) => {
        calls.push(`close ${formatRef(r)}`);
      },
    } as unknown as SessionRuntime;
    await expect(openSession(rt, { name: "x", cwd: "/", env: {}, role: "lane" }, "omo")).rejects.toThrow(
      "send refused",
    );
    expect(calls).toEqual(["start", "close hc:t4"]);
  });

  test("a failed create starts nothing", async () => {
    let started = false;
    const rt = {
      create: async () => {
        throw new Error("no space");
      },
      start: async () => {
        started = true;
      },
    } as unknown as SessionRuntime;
    await expect(openSession(rt, { name: "x", cwd: "/", env: {}, role: "lead" }, "omo")).rejects.toThrow("no space");
    expect(started).toBe(false);
  });
});

describe("Runtimes with a lazy choice", () => {
  test("for(ref) never calls the choice; default does", () => {
    let asked = 0;
    const make = (kind: RuntimeKind): SessionRuntime => ({ kind }) as unknown as SessionRuntime;
    const rts = new Runtimes(() => {
      asked += 1;
      return "hc";
    }, make);
    expect(rts.for({ runtime: "hc", id: "t3" }).kind).toBe("hc");
    expect(asked).toBe(0);
    expect(rts.default.kind).toBe("hc");
    expect(asked).toBe(1);
  });
});
