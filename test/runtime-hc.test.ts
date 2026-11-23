import { describe, expect, test } from "bun:test";
import { HcError } from "../src/runtime/hc/exec.ts";
import { parseProbe } from "../src/runtime/hc/probe.ts";
import { slugName } from "../src/runtime/hc/sessions.ts";
import { openSession } from "../src/runtime/types.ts";
import { terminal } from "./fake-hc.ts";
import { lane, rig, SH, T1 } from "./hc-rig.ts";

describe("create / start", () => {
  test("create argv is exact: background, no parent, no notes, labels, slug name, env utility then the user's shell", async () => {
    const { fake, rt } = rig({}, SH);
    const ref = await rt.create(lane);
    expect(ref).toEqual({ runtime: "hc", id: "t1", group: "g1" });
    expect(fake.calls).toEqual([
      ["ls"],
      [
        "run",
        "--bg",
        "--no-parent",
        "--no-notify",
        "--cwd",
        "/w",
        "--label",
        "dori.group=g1",
        "--label",
        "dori.role=lane",
        "--label",
        "dori.name=Lane K",
        "--label",
        "dori.lane=Lane K",
        "--name",
        "lane-k",
        "--",
        "env",
        "A=1",
        "B=it's a b",
        "/bin/zsh",
      ],
    ]);
  });

  test("no group labels dori.group=dori; a non-lane role has no dori.lane label; no SHELL runs sh", async () => {
    const { fake, rt } = rig();
    const ref = await rt.create({ name: "lead", cwd: "/r", env: {}, role: "lead" });
    expect(ref).toEqual({ runtime: "hc", id: "t1", group: "dori" });
    expect(fake.calls[1]).toEqual([
      "run",
      "--bg",
      "--no-parent",
      "--no-notify",
      "--cwd",
      "/r",
      "--label",
      "dori.group=dori",
      "--label",
      "dori.role=lead",
      "--label",
      "dori.name=lead",
      "--name",
      "lead",
      "--",
      "env",
      "sh",
    ]);
  });

  test("start sends the command into the shell with no status gate", async () => {
    const { fake, rt } = rig({ t1: terminal({ status: null, reported: false }) });
    await rt.start(T1, "omo --x 'a b'");
    expect(fake.calls).toEqual([["send", "t1", "--", "omo --x 'a b'"]]);
  });

  test("openSession is create then start", async () => {
    const { fake, rt } = rig({}, SH);
    expect(await openSession(rt, lane, "omo")).toEqual({ runtime: "hc", id: "t1", group: "g1" });
    expect(fake.calls.map((c) => c[0])).toEqual(["ls", "run", "send"]);
    expect(fake.calls[2]).toEqual(["send", "t1", "--", "omo"]);
  });

  test("a live terminal holding the slug drops --name (hc names are unique among live terminals)", async () => {
    const { fake, rt } = rig({ t1: terminal({ name: "lane-k" }) });
    expect(await rt.create(lane)).toEqual({ runtime: "hc", id: "t2", group: "g1" });
    expect(fake.calls[1]).not.toContain("--name");
  });

  test("a finished terminal with the same name does not block the name", async () => {
    const { fake, rt } = rig({ t1: terminal({ name: "lane-k", state: "finished" }) });
    await rt.create(lane);
    expect(fake.calls[1]).toContain("--name");
  });

  test("a name taken between ls and run is retried once without --name", async () => {
    const { fake, rt } = rig();
    fake.knobs.nameTaken = true;
    expect(await rt.create(lane)).toEqual({ runtime: "hc", id: "t1", group: "g1" });
    expect(fake.calls.filter((c) => c[0] === "run").map((c) => c.includes("--name"))).toEqual([true, false]);
  });

  test("an env key that is not a shell name is refused before anything runs", async () => {
    const { fake, rt } = rig();
    await expect(rt.create({ ...lane, env: { "-i": "x" } })).rejects.toThrow(/-i/);
    expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
  });
});

describe("slugName", () => {
  test.each([
    ["Lane K", "lane-k"],
    ["my lane/ünïcode!!", "my-lane--n-code--"],
    ["a.b_c-d", "a.b_c-d"],
    ["x".repeat(40), "x".repeat(32)],
    ["", undefined],
    ["ünicode", "nicode"],
    ["-_.lead", "lead"],
    ["t7", undefined],
    ["T12", undefined],
    ["t7x", "t7x"],
    ["---", undefined],
  ] as const)("%p -> %p", (name, want) => {
    expect(slugName(name)).toBe(want);
  });
});

describe("probe", () => {
  test.each([
    [
      "idle",
      terminal(),
      {
        status: "idle",
        agent: "omo",
        pgid: 4242,
        rootPid: 900,
        turn: 3,
        title: "omo lane",
        cwd: "/w",
        shellInFront: false,
      },
    ],
    ["working", terminal({ status: { state: "working", app: "omo" } }), { status: "working", agent: "omo" }],
    ["blocked", terminal({ status: { state: "blocked", app: "omo" } }), { status: "blocked" }],
    ["error", terminal({ status: { state: "error", app: "omo" } }), { status: "error" }],
    ["done", terminal({ status: { state: "done", app: "omo" } }), { status: "done" }],
    [
      "unreported shell",
      terminal({ status: null, reported: false, foreground: { name: "bash", argv: ["/bin/bash"], pid: 7 } }),
      { status: "shell", agent: "bash", pgid: 7, shellInFront: true },
    ],
    [
      "unreported program",
      terminal({ status: null, reported: false, foreground: { name: "node", argv: ["node", "x.js"], pid: 8 } }),
      { status: "unknown", agent: "node", shellInFront: false },
    ],
    ["finished", terminal({ state: "finished" }), { status: "gone" }],
    ["unknown word", terminal({ status: { state: "thinking" } }), { status: "unknown", agent: "omo" }],
  ] as const)("%s", async (_, t, want) => {
    const { rt } = rig({ t1: t });
    expect(await rt.probe(T1)).toMatchObject(want);
  });

  test("a terminal hc does not know is gone", async () => {
    const { rt } = rig();
    expect(await rt.probe(T1)).toEqual({ status: "gone", shellInFront: false });
  });

  test("any other get failure throws an HcError carrying hc's kind and hint", async () => {
    const { fake, rt } = rig({ t1: terminal() });
    fake.knobs.getError = "unavailable";
    const err = await rt.probe(T1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HcError);
    expect(err).toMatchObject({ kind: "unavailable", hint: "hint for unavailable" });
  });

  test("parseProbe reads hc's own get shape (the live bash terminal this host has)", () => {
    const live = {
      address: "t1",
      argv: ["/bin/bash"],
      cwd: "/h",
      foreground: { argv: ["/bin/bash"], cwd: "/h", name: "bash", pid: 11 },
      pid: 11,
      reported: false,
      state: "live",
      status: null,
      title: "u@h: ~",
      turn: 0,
    };
    expect(parseProbe(live)).toEqual({
      status: "shell",
      agent: "bash",
      pgid: 11,
      rootPid: 11,
      turn: 0,
      title: "u@h: ~",
      cwd: "/h",
      shellInFront: true,
      foreground: [{ name: "bash", argv: ["/bin/bash"], pid: 11 }],
    });
  });
});
