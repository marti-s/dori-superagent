import { expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { parse, USAGE } from "../src/cli-args.ts";
import { startLane } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";
import { sref } from "./fake.ts";

test("a value flag left without a value at the end is refused; nothing is sent or started", async () => {
  const { d, lead, brief } = setup();
  await startLane(d, "a-lane", brief, { group: "w1" });
  lead.received.length = 0;
  await expect(main(["send", "lead", "--text"], d)).rejects.toThrow("--text needs a value");
  await expect(main(["report", "a-lane", "--text"], d)).rejects.toThrow("--text needs a value");
  await expect(main(["start", "b-lane", "--brief", brief, "--cwd"], d)).rejects.toThrow("--cwd needs a value");
  expect(lead.received).toEqual([]);
  expect(d.store.queued(sref("t1"))).toEqual([]);
  expect(d.store.lane("b-lane")).toBeUndefined();
});

test("boolean flags still need no value, and a value flag still takes the next argument verbatim", () => {
  expect(parse(["duty", "--once"]).flags.get("once")).toEqual(["true"]);
  expect(parse(["--help"]).flags.get("help")).toEqual(["true"]);
  expect(parse(["send", "lead", "--text", "--to-shell"]).flags.get("text")).toEqual(["--to-shell"]);
});

test("--help before a command prints the usage and runs nothing", async () => {
  const { w, d } = setup();
  const before = w.calls.length;
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.join(" "));
  };
  try {
    expect(await main(["--help", "merge", "x/y#1"], d)).toBe(0);
  } finally {
    console.log = log;
  }
  expect(lines).toEqual([USAGE]);
  expect(w.calls.slice(before)).toEqual([]);
});
