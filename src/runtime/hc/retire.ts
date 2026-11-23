import type { Exec } from "../exec.ts";
import { type AppTab, closeTab, tabOf } from "./app.ts";
import { hcCall, isKind } from "./exec.ts";
import { probe } from "./probe.ts";
import { close } from "./sessions.ts";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The terminal's launch argv, or undefined when hc no longer knows it. */
async function launchArgv(exec: Exec, id: string): Promise<readonly string[] | undefined> {
  try {
    const argv = (await hcCall(exec, ["get", id]))["argv"];
    return Array.isArray(argv) ? argv.map(String) : [];
  } catch (e) {
    if (isKind(e, "not_found")) return undefined;
    throw e;
  }
}

/**
 * Removes a finished lane's terminal (kill, then rm) and closes its Herdr tab. hc may hand a removed address to a new
 * terminal, so only the terminal Dori launched for this lane is touched: its launch argv carries `DORI_LANE=<key>`.
 * A tab that still holds another live terminal is kept. Returns what was done, for the lane's log.
 */
export async function retire(
  exec: Exec,
  app: string,
  id: string,
  laneKey: string,
  sleep: (ms: number) => Promise<void>,
  log: (line: string) => void,
): Promise<string> {
  const argv = await launchArgv(exec, id);
  if (argv !== undefined && !argv.includes(`DORI_LANE=${laneKey}`))
    return `kept: terminal ${id} is not the one dori started for lane ${laneKey}`;
  let tab: AppTab | undefined;
  let tabProblem = "";
  try {
    tab = await tabOf(exec, app, id);
  } catch (e) {
    tabProblem = messageOf(e);
  }
  const others: string[] = [];
  for (const other of tab?.terminals.filter((t) => t !== id) ?? [])
    if ((await probe(exec, other)).status !== "gone") others.push(other);
  if (argv !== undefined) await close(exec, id, sleep, log);
  const removed = argv === undefined ? `terminal ${id} already gone` : `terminal ${id} removed`;
  if (tabProblem) return `${removed}; tab not closed: ${tabProblem}`;
  if (tab === undefined) return `${removed}; no app tab held it`;
  if (others.length > 0) return `${removed}; tab ${tab.id} kept: it holds live ${others.join(", ")}`;
  const refused = await closeTab(exec, app, tab.id);
  return refused === undefined
    ? `${removed}; tab ${tab.id} closed`
    : `${removed}; tab ${tab.id} not closed: ${refused}`;
}
