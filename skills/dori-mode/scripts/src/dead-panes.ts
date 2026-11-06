import type { DoriConfig } from "./config.ts";
import { ALIVE_STATUSES, agentStatus, listPanes, readScreen } from "./panes.ts";
import type { Runner } from "./run.ts";

/** Unrecognised ticks in a row before one alert names the pane. */
export const UNRECOGNISED_ALERT_AFTER = 3;

/** Per-pane memory across ticks: the CLI keeps one of these for the life of the loop. */
export type DeadPaneState = { readonly unknown: Map<string, number>; readonly lastTail: Map<string, string> };
export const newDeadPaneState = (): DeadPaneState => ({ unknown: new Map(), lastTail: new Map() });

/**
 * A pane is alive when its derived agent status (see agentStatus) is a running one; that wins over any marker text. Otherwise it is
 * dead only when this tick's tail carries a configured dead marker AND equals the previous tick's tail, so the two
 * reads are a full loop interval apart and a screen mid-redraw never counts. A marker seen once is pending. Anything
 * else is unrecognised, counted per pane, with one alert after UNRECOGNISED_ALERT_AFTER ticks in a row.
 */
export const deadPaneTick = async (run: Runner, config: DoriConfig, seen: Set<string>, hourKey: string, state: DeadPaneState = newDeadPaneState()): Promise<string[]> => {
  const out: string[] = [];
  const watch = new Set(config.workspaces);
  const skip = new Set([config.leadPane, ...config.ignorePanes].filter(Boolean));
  const marked = (tail: string) => config.deadPanePatterns.some((p) => tail.includes(p.toLowerCase()));
  for (const pane of await listPanes(run)) {
    if (skip.has(pane.pane_id) || (watch.size > 0 && !watch.has(pane.workspace_id))) continue;
    const status = pane.agent_status ?? (await agentStatus(run, pane.pane_id));
    if (status && ALIVE_STATUSES.has(status)) {
      state.unknown.delete(pane.pane_id);
      state.lastTail.delete(pane.pane_id);
      continue;
    }
    const tail = (await readScreen(run, pane.pane_id, 6)).toLowerCase();
    const previous = state.lastTail.get(pane.pane_id);
    state.lastTail.set(pane.pane_id, tail);
    if (marked(tail)) {
      state.unknown.delete(pane.pane_id);
      if (previous !== tail) continue;
      const mark = `${pane.pane_id} ${hourKey}`;
      if (seen.has(mark)) continue;
      seen.add(mark);
      out.push(`DEAD_PANE ${pane.pane_id}`);
      continue;
    }
    const n = (state.unknown.get(pane.pane_id) ?? 0) + 1;
    state.unknown.set(pane.pane_id, n);
    if (n === UNRECOGNISED_ALERT_AFTER) out.push(`UNRECOGNISED_PANE ${pane.pane_id} dead-panes: no alive status and no dead marker for ${n} ticks`);
  }
  return out;
};
