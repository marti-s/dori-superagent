import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shq } from "./delivery.ts";
import { prompt, type Deps } from "./harness.ts";
import { settled, tellLead, type SendResult } from "./inbox.ts";
import { Refusal } from "./refusal.ts";
import { runHook } from "./hooks.ts";
import { refText } from "./refs.ts";
import { groupId } from "./runtime/group.ts";
import { openSession } from "./runtime/types.ts";
import { KEY_RE, reservedKey, type Lane } from "./store-types.ts";

export async function startLane(
  d: Deps,
  key: string,
  briefFile: string,
  opts: { cwd?: string; group?: string } = {},
): Promise<Lane> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const reserved = reservedKey(key);
  if (reserved) throw new Refusal(reserved);
  const existing = d.store.lane(key);
  if (existing && existing.status !== "done" && existing.status !== "lost") {
    // A lane whose terminal finished or vanished is lost, not open: record that, then start the key afresh.
    const { sessionRef } = existing;
    const gone = existing.status !== "ready" && (await d.runtimes.for(sessionRef).probe(sessionRef)).status === "gone";
    if (!gone) throw new Refusal(`lane ${key} is already open in ${refText(sessionRef)}`);
    await markLost(d, existing);
  }
  const cwd = resolve(opts.cwd ?? process.cwd());
  const briefPath = d.store.briefPath(key);
  const footer = prompt("lane-footer.md", { key, dori: d.doriCmd });
  await Bun.write(briefPath, `${readFileSync(briefFile, "utf8").trimEnd()}\n\n${footer}`);

  // The group is this home's label unless the caller names one.
  const rt = d.runtimes.default;
  const group = opts.group ?? groupId(d.store.root);
  const kickoff = `Read your brief at ${briefPath} and execute it. Your lane key is ${key}.`;
  const ref = await openSession(
    rt,
    { name: key, role: "lane", cwd, env: { ...d.sessionEnv, DORI_LANE: key, DORI_HOME: d.store.root }, group },
    `${d.agentCmd} ${shq(kickoff)}`,
  );

  const now = d.now();
  const lane: Lane = {
    key,
    sessionRef: ref,
    paneId: ref.id,
    tabId: ref.id,
    brief: briefPath,
    cwd,
    status: "working",
    createdAt: now,
    lastActivityAt: now,
    nudges: 0,
    log: [{ at: now, kind: "start", text: briefFile }],
  };
  d.store.saveLane(lane);
  await tellLead(d, `[START ${key}] lane opened in ${refText(ref)}`, key);
  const open = d.store.lanes().filter((l) => l.status === "working" || l.status === "waiting").length;
  d.usage.record({ name: "dori.lane_started", open_lanes: Math.min(open, 1000) });
  return lane;
}

function openLane(d: Deps, key: string): Lane {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status === "done" || lane.status === "lost") throw new Refusal(`lane ${key} is ${lane.status}`);
  return lane;
}

export async function report(
  d: Deps,
  key: string,
  text: string,
  status?: "working" | "waiting",
): Promise<SendResult | undefined> {
  const lane = openLane(d, key);
  const now = d.now();
  lane.log.push({ at: now, kind: "report", text });
  lane.lastActivityAt = now;
  lane.nudges = 0;
  if (status) lane.status = status;
  d.store.saveLane(lane);
  void runHook(d, "onReport", { key, text, evidence: "" });
  return settled(tellLead(d, `[REPORT ${key}${status === "waiting" ? " WAITING" : ""}] ${text}`, key));
}

export async function ready(
  d: Deps,
  key: string,
  text: string,
  evidence: readonly string[],
): Promise<SendResult | undefined> {
  if (evidence.length === 0) throw new Refusal("READY needs at least one --evidence link (a PR, a receipt, a file)");
  if (!text.trim()) throw new Refusal("READY needs the final answer text");
  const lane = openLane(d, key);
  const now = d.now();
  lane.status = "ready";
  lane.final = { text, evidence: [...evidence], at: now };
  lane.lastActivityAt = now;
  lane.log.push({ at: now, kind: "ready", text });
  d.store.saveLane(lane);
  const sent = await settled(tellLead(d, `[READY ${key}] ${text}\nevidence: ${evidence.join(" ")}`, key));
  void runHook(d, "onReady", { key, text, evidence: evidence.join(" ") });
  d.usage.record({
    name: "dori.lane_ready",
    evidence_count: Math.min(evidence.length, 100),
    lane_minutes: Math.min(Math.floor((now - lane.createdAt) / 60_000), 10_080),
  });
  return sent;
}

/**
 * Closes a lane. Without `abandon`, only a READY lane closes. With it, the lead closes a lane that will never report
 * READY (wedged, finished or lost); the reason is kept in the lane's log. The lane's terminal is stopped and kept
 * readable: the duty loop removes it, and closes its tab, a while after.
 */
export async function done(d: Deps, key: string, abandon?: { note: string }): Promise<void> {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (abandon) {
    if (!abandon.note.trim()) throw new Refusal("--abandon needs a --note saying why");
    if (lane.status === "done") throw new Refusal(`lane ${key} is already done`);
  } else if (lane.status !== "ready") {
    const how = "close it anyway with --abandon --note WHY";
    throw new Refusal(`lane ${key} is ${lane.status}, not ready: no final answer recorded (${how})`);
  }
  const rt = d.runtimes.for(lane.sessionRef);
  const { status: st } = await rt.probe(lane.sessionRef);
  if (!abandon && (st === "working" || st === "blocked" || st === "error"))
    throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
  if (st !== "gone") await rt.stop(lane.sessionRef);
  lane.status = "done";
  lane.closedAt = d.now();
  const text = abandon ? `abandoned without READY: ${abandon.note}` : "closed by lead";
  lane.log.push({ at: lane.closedAt, kind: "done", text });
  d.store.saveLane(lane);
}

const LOST = "terminal finished or disappeared without READY";

/** A lane whose terminal finished or vanished without READY: recorded as lost and reported to the lead as [LOST]. */
export async function markLost(d: Deps, lane: Lane): Promise<void> {
  lane.status = "lost";
  lane.closedAt = d.now();
  lane.log.push({ at: lane.closedAt, kind: "lost", text: LOST });
  d.store.saveLane(lane);
  void runHook(d, "onLost", { key: lane.key, text: LOST, evidence: "" });
  const where = refText(lane.sessionRef);
  await tellLead(d, `[LOST ${lane.key}] terminal ${where} finished or closed without a final answer`, "duty");
}
