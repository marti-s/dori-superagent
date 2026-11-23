import { HcRuntime } from "../src/runtime/hc/index.ts";
import type { CreateSpec, SessionRef } from "../src/runtime/types.ts";
import { FakeHc, type FakeTerminal } from "./fake-hc.ts";

// The hc adapter over the FakeHc recorder, shared by the runtime-hc*.test.ts files.
export const T1: SessionRef = { runtime: "hc", id: "t1" };

export function rig(initial: Record<string, FakeTerminal> = {}, env: Record<string, string | undefined> = {}) {
  const fake = new FakeHc(initial);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const rt = new HcRuntime(fake.exec, {
    env,
    sleep: async (ms) => void sleeps.push(ms),
    log: (line) => void logs.push(line),
  });
  return { fake, rt, sleeps, logs };
}

export const lane: CreateSpec = {
  name: "Lane K",
  cwd: "/w",
  env: { A: "1", B: "it's a b" },
  role: "lane",
  group: "g1",
};
export const SH = { SHELL: "/bin/zsh" };
