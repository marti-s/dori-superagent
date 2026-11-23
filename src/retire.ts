import { failureDetail } from "./delivery.ts";
import type { DutyEvent } from "./duty.ts";
import type { Deps } from "./harness.ts";
import { refText, sameSession } from "./refs.ts";

/**
 * Retires the terminal and Herdr tab of every lane done or lost at least tabCloseDelayMs ago, once. A lane restarted
 * since is working again and has no closedAt. The lead's, duty's and the loops' terminals are never touched, and the
 * runtime keeps any terminal it cannot prove is this lane's and any tab another live terminal still uses.
 */
export async function retireClosedLanes(d: Deps, events: DutyEvent[]): Promise<void> {
  if (d.tabCloseDelayMs <= 0) return;
  const kept = Object.values(d.store.roles());
  for (const listed of d.store.lanes()) {
    const { key, sessionRef, closedAt } = listed;
    if (listed.status !== "done" && listed.status !== "lost") continue;
    if (closedAt === undefined || listed.retiredAt !== undefined || d.now() - closedAt < d.tabCloseDelayMs) continue;
    try {
      const text = kept.some((ref) => sameSession(ref, sessionRef))
        ? `kept: terminal ${refText(sessionRef)} is the lead's, duty's or a loop's`
        : await d.runtimes.for(sessionRef).retire(sessionRef, key);
      // Re-read before saving: the key may have been started again while its old terminal was being removed.
      const lane = d.store.lane(key);
      if (lane === undefined || lane.closedAt !== closedAt || !sameSession(lane.sessionRef, sessionRef)) continue;
      const now = d.now();
      lane.retiredAt = now;
      lane.log.push({ at: now, kind: "retired", text });
      d.store.saveLane(lane);
      events.push({ lane: key, action: "retired", detail: text });
    } catch (e) {
      // Tried again on the next pass; one lane's failure never stops the others.
      events.push({ lane: key, action: "retire-failed", detail: failureDetail(e) });
    }
  }
}
