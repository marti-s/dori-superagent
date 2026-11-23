// The boot check a fresh lead cannot make by itself (#188): lanes whose session is gone while the registry still calls
// them open. Each finding is one line and fails the boot.
import type { Runtimes } from "../../../../src/runtime/registry.ts";
import type { SessionInfo } from "../../../../src/runtime/types.ts";
import { type BootLane, finished } from "./boot-monitors.ts";
import { sessionOf } from "./registry.ts";

/**
 * `DRIFT n=<count>`: lanes not finished (closed, verified-done, or a done report, the lanes VANISHED skips too) whose session the runtime's own probe reports `gone`. Only lanes the session list
 * no longer shows are probed, so a live lane costs no extra call; a probe that fails is named. Any drift or failed probe fails the boot.
 */
export const driftCheck = async (
  rts: Runtimes,
  lanes: readonly BootLane[],
  sessions: readonly SessionInfo[],
): Promise<{ readonly lines: string[]; readonly failed: boolean }> => {
  const live = new Set(sessions.map((s) => `${s.ref.runtime}:${s.ref.id}`));
  const gone: string[] = [];
  const lines: string[] = [];
  let failed = false;
  for (const lane of lanes) {
    const ref = sessionOf(lane);
    if (!ref || finished(lane) || live.has(`${ref.runtime}:${ref.id}`)) continue;
    try {
      if ((await rts.for(ref).probe(ref)).status === "gone") gone.push(lane.key);
    } catch (e) {
      failed = true;
      lines.push(`DRIFT probe-failed ${lane.key} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return {
    lines: [`DRIFT n=${gone.length}${gone.length ? ` ${gone.join(" ")}` : ""}`, ...lines],
    failed: failed || gone.length > 0,
  };
};
