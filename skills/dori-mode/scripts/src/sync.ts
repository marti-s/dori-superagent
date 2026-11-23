import { formatRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import { statusOf } from "./registry.ts";
import { runtimesOf } from "./run.ts";
import { procTable, resolveSession } from "./session-id.ts";
import { listSessions, listWatched } from "./sessions.ts";

export type SyncRow = {
  readonly key: string;
  readonly thread: string;
  readonly pane: string;
  readonly session: string;
  readonly status: string;
};
export type SyncResult = { readonly rows: SyncRow[]; readonly drift: string[]; readonly unregistered: SyncRow[] };

export const syncRegistry = async (deps: FlowDeps, write: boolean): Promise<SyncResult> => {
  const rts = runtimesOf(deps);
  const lanes = await deps.registry.open();
  const sessions = await listSessions(rts, { lanes });
  const live = new Map(sessions.map((s) => [formatRef(s.ref), s]));
  const table = await procTable(deps.run);
  const rows: SyncRow[] = [];
  const drift: string[] = [];
  const resolveDeps = { run: deps.run, sessionsDir: deps.config.sessionsDir, rts };
  for (const lane of lanes) {
    const session = lane.sessionRef ? live.get(formatRef(lane.sessionRef)) : undefined;
    if (!session) drift.push(`${lane.key}: pane ${lane.pane ?? "(none)"} is gone but the lane is ${statusOf(lane)}`);
    const hit = session
      ? await resolveSession(session.ref, session.cwd ?? "", table, resolveDeps)
      : { id: "", via: "none" };
    if (lane.session && hit.id && hit.id !== lane.session)
      drift.push(`${lane.key}: pane now runs session ${hit.id} (registry has ${lane.session})`);
    if (!lane.done) drift.push(`${lane.key}: empty Done line, so a done claim can never close it`);
    if (write && hit.id && hit.id !== lane.session)
      await deps.registry.write({ ...lane, session: hit.id, sessionVia: hit.via });
    rows.push({
      key: lane.key,
      thread: lane.thread,
      pane: lane.pane ?? "-",
      session: hit.id ? `${hit.id} (${hit.via})` : (lane.session ?? "-"),
      status: statusOf(lane),
    });
  }
  const owned = new Set(lanes.flatMap((l) => (l.sessionRef ? [formatRef(l.sessionRef)] : [])));
  const skip = new Set([deps.config.leadPane, ...deps.config.ignorePanes]);
  const watched = deps.config.workspaces.length > 0 ? await listWatched(rts, deps.config.workspaces, lanes) : sessions;
  const unregistered: SyncRow[] = [];
  for (const s of watched) {
    const id = s.ref.id;
    if (owned.has(formatRef(s.ref)) || skip.has(id)) continue;
    if (s.agent === undefined) continue;
    const hit = await resolveSession(s.ref, s.cwd ?? "", table, resolveDeps);
    unregistered.push({
      key: s.title ?? s.name ?? id,
      thread: "-",
      pane: id,
      session: hit.id ? `${hit.id} (${hit.via})` : "-",
      status: "unregistered",
    });
  }
  return { rows, drift, unregistered };
};
