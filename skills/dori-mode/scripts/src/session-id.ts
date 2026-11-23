import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { SessionRef } from "../../../../src/runtime/types.ts";
import { type ChosenRuntimes, type Runner, runtimesFor } from "./run.ts";

export type Proc = { readonly pid: number; readonly ppid: number; readonly cmd: string };
export type SessionHit = {
  readonly id: string;
  readonly via: "argv" | "child-env" | "start-time" | "none";
  readonly pid?: number;
};

const AGENT = /senpi\/dist\/bundle\/cli\.js|(^|\/)omo(\s|$)/;
const ENV_ID = /(?:^|\s)PI_SESSION_ID=([0-9a-f-]{36})(?:\s|$)/;
const SESSION_FILE = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z_([0-9a-f-]{36})\.jsonl$/;
const START_WINDOW_MS = 180_000;

export const procTable = async (run: Runner): Promise<Proc[]> =>
  (await run(["ps", "-A", "-o", "pid=,ppid=,command="])).out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] ?? "" }] : [];
  });

const descendants = (table: readonly Proc[], root: number): Proc[] => {
  const byParent = new Map<number, Proc[]>();
  for (const p of table) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const out: Proc[] = [];
  const queue = [...(byParent.get(root) ?? [])];
  for (let p = queue.shift(); p; p = queue.shift()) {
    out.push(p);
    queue.push(...(byParent.get(p.pid) ?? []));
  }
  return out;
};

export const sessionDirFor = (sessionsDir: string, cwd: string): string =>
  join(sessionsDir, `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);

/** The session id and creation time a session file name carries, or undefined for any other file. */
export const sessionFileStart = (name: string): { readonly id: string; readonly at: number } | undefined => {
  const m = SESSION_FILE.exec(name);
  const at = m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : Number.NaN;
  return m?.[5] && !Number.isNaN(at) ? { id: m[5], at } : undefined;
};

export type SessionDeps = {
  readonly run: Runner;
  /** Resolves the session's root process; built over `run` when absent (a stored ref needs no runtime choice). */
  readonly rts?: ChosenRuntimes;
  readonly sessionsDir: string;
  readonly listDir?: (dir: string) => readonly string[];
};

/** The session's root process (the hc terminal's program); 0 when the runtime cannot say. */
const rootPidOf = async (ref: SessionRef, deps: SessionDeps): Promise<number> => {
  const rts = deps.rts ?? runtimesFor({}, process.env, deps.run);
  try {
    return (await rts.for(ref).probe(ref)).rootPid ?? 0;
  } catch {
    return 0;
  }
};

export const resolveSession = async (
  ref: SessionRef,
  cwd: string,
  table: readonly Proc[],
  deps: SessionDeps,
): Promise<SessionHit> => {
  const rootPid = await rootPidOf(ref, deps);
  // The root itself is a candidate: an agent run directly as the session's program has no shell above it.
  const candidates = rootPid ? [...table.filter((p) => p.pid === rootPid), ...descendants(table, rootPid)] : [];
  const agent = candidates.find((p) => AGENT.test(p.cmd) && !/\bmcp\b/.test(p.cmd));
  if (!agent) return { id: "", via: "none" };
  const argv = agent.cmd.split(/\s+/);
  const flagAt = argv.indexOf("--session");
  const fromFlag = flagAt >= 0 ? (argv[flagAt + 1] ?? "") : "";
  if (fromFlag) return { id: fromFlag, via: "argv", pid: agent.pid };
  for (const child of descendants(table, agent.pid).slice(0, 40)) {
    const env = await deps.run(["ps", "eww", "-o", "command=", "-p", String(child.pid)]);
    const hit = ENV_ID.exec(env.out);
    if (hit?.[1]) return { id: hit[1], via: "child-env", pid: agent.pid };
  }
  const started = Date.parse((await deps.run(["ps", "-o", "lstart=", "-p", String(agent.pid)])).out);
  if (Number.isNaN(started)) return { id: "", via: "none", pid: agent.pid };
  const list =
    deps.listDir ??
    ((d: string) => {
      try {
        return readdirSync(d);
      } catch {
        return [];
      }
    });
  const near = list(sessionDirFor(deps.sessionsDir, cwd))
    .flatMap((name) => {
      const hit = sessionFileStart(name);
      return hit && hit.at >= started - 5_000 && hit.at <= started + START_WINDOW_MS ? [hit] : [];
    })
    .sort((a, b) => a.at - b.at);
  return near[0] ? { id: near[0].id, via: "start-time", pid: agent.pid } : { id: "", via: "none", pid: agent.pid };
};
