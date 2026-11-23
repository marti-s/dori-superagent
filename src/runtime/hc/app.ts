// The Herdr app window, through `herdr-app`: hc starts terminals, the window shows them in tabs. Every call here is
// about a tab, never about a terminal's program.
import type { Exec } from "../exec.ts";

/** One tab of the window: its id and the hc terminals shown in it. */
export type AppTab = { readonly id: string; readonly terminals: readonly string[] };

/** The window lists a new terminal shortly after hc starts it: a tab not listed yet is looked up again this often. */
export const TAB_LOOKUPS = 10;
export const TAB_LOOKUP_MS = 200;

const rec = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function tabs(exec: Exec, app: string): Promise<AppTab[]> {
  const listed = await exec(app, ["ls"]);
  if (listed.code !== 0) throw new Error((listed.stderr || listed.stdout).trim() || `exit ${listed.code}`);
  const out: AppTab[] = [];
  for (const space of list(rec(JSON.parse(listed.stdout))["spaces"])) {
    for (const tab of list(rec(space)["tabs"]).map(rec)) {
      const id = tab["id"];
      if (typeof id !== "string") throw new Error("herdr-app listed a tab without an id");
      out.push({ id, terminals: list(tab["terminals"]).map((t) => String(rec(t)["terminal"])) });
    }
  }
  return out;
}

/** The tab holding the terminal, with every terminal in it; undefined when the window lists none. */
export async function tabOf(exec: Exec, app: string, terminal: string): Promise<AppTab | undefined> {
  return (await tabs(exec, app)).find((tab) => tab.terminals.includes(terminal));
}

/**
 * Names the tab holding a terminal hc just started, looking the tab up again until the window lists it. Best effort:
 * a window that is closed, a missing `herdr-app` or a tab that never appears is one logged line, never a failed launch.
 */
export async function nameTab(
  exec: Exec,
  app: string,
  terminal: string,
  name: string,
  sleep: (ms: number) => Promise<void>,
  log: (line: string) => void,
): Promise<void> {
  try {
    for (let attempt = 0; attempt < TAB_LOOKUPS; attempt++) {
      if (attempt > 0) await sleep(TAB_LOOKUP_MS);
      const tab = await tabOf(exec, app, terminal);
      if (tab === undefined) continue;
      const renamed = await exec(app, ["do", "tab.rename", "--id", tab.id, "--name", name]);
      if (renamed.code !== 0) throw new Error((renamed.stderr || renamed.stdout).trim() || `exit ${renamed.code}`);
      return;
    }
    throw new Error("no app tab holds the terminal");
  } catch (e) {
    log(`dori: could not name the app tab of ${terminal} "${name}": ${messageOf(e)}`);
  }
}
