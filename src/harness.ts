import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { CommandError, DeliveryUncertain, shq, spawnExec, type AgentStatus, type Exec, type TerminalBackend } from "./terminal.ts";
import { KEY_RE, reservedKey, Store, type DeliveryAttempt, type HostLoad, type Lane, type QueuedMessage, type Role } from "./store.ts";
import { Telemetry, type MergeOutcome, type Usage } from "./telemetry.ts";
import { HerdrCore } from "./herdr-core.ts";
import { attestBootstrap, parseFormaQueueBootstrap, type FormaQueueBootstrap } from "./native-bootstrap.ts";
import { Refusal } from "./refusal.ts";

export { KEY_RE, reservedKey };
export { Refusal } from "./refusal.ts";

export const NUDGE_MINUTES = [10, 20, 40] as const;
const PROMPTS = join(import.meta.dir, "..", "prompts");
const CLI = resolve(import.meta.dir, "cli.ts");

export type Deps = {
  readonly store: Store;
  readonly herdr: TerminalBackend;
  readonly exec: Exec;
  /** Optional executable and literal arguments for the landing queue backend. */
  readonly landingBackend?: readonly string[];
  readonly formaQueueBootstrap?: FormaQueueBootstrap;
  readonly now: () => number;
  readonly agentCmd: string;
  /** How long one reviewer run may take before it is killed and the review fails. */
  readonly reviewTimeoutMs: number;
  /** How long after a lane is done or lost the duty loop retires its terminal and tab; 0 never retires them. */
  readonly tabCloseDelayMs: number;
  readonly doriCmd: string;
  readonly host: () => HostLoad;
  readonly usage: Usage;
};

export const defaultDeps = (): Deps => {
  const landingBackend = landingBackendArgv(process.env["DORI_LANDING_BACKEND"]);
  const formaQueueBootstrap = parseFormaQueueBootstrap(process.env["FORMA_QUEUE_BOOTSTRAP"]);
  const store = new Store();
  return {
    store,
    herdr: new HerdrCore(),
    exec: spawnExec,
    landingBackend,
    formaQueueBootstrap,
    now: Date.now,
    agentCmd: process.env["DORI_AGENT_CMD"] ?? "omo",
    reviewTimeoutMs: reviewTimeoutMinutes(process.env["DORI_REVIEW_TIMEOUT_MIN"]) * 60_000,
    tabCloseDelayMs: tabCloseMinutes(process.env["DORI_TAB_CLOSE_MIN"]) * 60_000,
    doriCmd: process.env["DORI_CMD"] ?? `DORI_HOME=${shq(store.root)} bun ${shq(CLI)}`,
    host: () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length, memFreePct: memFreePct() }),
    usage: new Telemetry(store.root),
  };
};

function landingBackendArgv(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const message = "DORI_LANDING_BACKEND must be a JSON nonempty array of nonempty strings";
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    throw new Refusal(message);
  }
  if (!Array.isArray(value) || value.length === 0 ||
      !value.every((arg: unknown) => typeof arg === "string" && arg.trim().length > 0)) {
    throw new Refusal(message);
  }
  return value;
}

const REVIEW_TIMEOUT_MIN = 25;
const TAB_CLOSE_MIN = 15;

/** DORI_TAB_CLOSE_MIN as minutes, 0 to never close; unset means 15, a negative or non-number is refused. */
export function tabCloseMinutes(raw: string | undefined): number {
  if (raw === undefined || raw === "") return TAB_CLOSE_MIN;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error(`DORI_TAB_CLOSE_MIN must be 0 or a positive number of minutes, not ${JSON.stringify(raw)}`);
  return minutes;
}

/** DORI_REVIEW_TIMEOUT_MIN as a positive number of minutes; unset means 25, anything else is refused. */
export function reviewTimeoutMinutes(raw: string | undefined): number {
  if (raw === undefined || raw === "") return REVIEW_TIMEOUT_MIN;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`DORI_REVIEW_TIMEOUT_MIN must be a positive number of minutes, not ${JSON.stringify(raw)}`);
  return minutes;
}

const sysctlMemoryLevel = (): string => execFileSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: 2000 });

/**
 * Percent of memory available to start new work. On Linux, os.freemem() is MemAvailable. On macOS it is only the
 * truly free pages (inactive and cached pages excluded), which sits near 0-5% on a healthy Mac, so the kernel's own
 * available-memory level (the figure behind Activity Monitor's memory pressure) is used there instead.
 */
export function memFreePct(
  platform: string = process.platform,
  readLevel: () => string = sysctlMemoryLevel,
  freePct: () => number = () => Math.round((freemem() / totalmem()) * 100),
): number {
  if (platform === "darwin") {
    try {
      const level = Number(readLevel().trim());
      if (Number.isFinite(level) && level >= 0 && level <= 100) return Math.round(level);
    } catch {
      // fall through to freemem(): a missing sysctl must not stop the loop from reading memory at all
    }
  }
  return freePct();
}

const prompt = (name: string, vars: Record<string, string>): string =>
  readFileSync(join(PROMPTS, name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

// ---------- pane messaging ----------

export function resolveTarget(d: Deps, target: string): string {
  const roles = d.store.roles();
  if (target === "lead" || target === "duty") {
    const pane = roles[target];
    if (!pane) throw new Refusal(`no ${target} pane registered (dori role ${target} <pane>)`);
    return pane;
  }
  const lane = d.store.lane(target);
  if (lane && lane.status !== "done") return lane.paneId;
  // A role or an open lane wins over an hc address, so a lane key such as `tests` still names its lane.
  if (/^t[0-9a-z]+$/.test(target)) return target;
  throw new Refusal(`unknown target ${target}: not an hc terminal address, role or open lane`);
}

// A pane with no running agent (`shell`) is never ready: text typed into a bare shell runs as a command (#66).
const READY_TO_READ: readonly AgentStatus[] = ["idle", "done"];

export type SendResult = "DELIVERED" | "QUEUED" | "HELD";

/**
 * Delivers now when the pane can read; otherwise queues it for the duty loop (busy agents are never interrupted).
 * The command-line path: an uncertain delivery is a result, never an error (see settled).
 */
export async function send(d: Deps, target: string, text: string, from: string): Promise<SendResult> {
  return settled(sendOrThrow(d, target, text, from));
}

/** send for the duty and hourly loops: throws DeliveryUncertain, having recorded it, so they report the failure. */
async function sendOrThrow(d: Deps, target: string, text: string, from: string): Promise<"DELIVERED" | "QUEUED"> {
  const paneId = resolveTarget(d, target);
  d.store.enqueue(paneId, { at: d.now(), from, text });
  return (await flushInbox(d, paneId)) === "delivered" ? "DELIVERED" : "QUEUED";
}

/**
 * An uncertain delivery is already recorded on the queued message (#89), so on the command-line path it is a result:
 * a sender who saw a failure would send again. `HELD`: it may or may not have reached the pane and is not resent.
 * `QUEUED`: typed text that only waits for its Enter.
 */
async function settled<T extends SendResult | undefined>(delivery: Promise<T>): Promise<T | "QUEUED" | "HELD"> {
  try {
    return await delivery;
  } catch (e) {
    if (e instanceof DeliveryUncertain) return e.typed ? "QUEUED" : "HELD";
    throw e;
  }
}

/**
 * `dori send --to-shell`: the operator's per-message opt-in to type this one message into a pane with no agent.
 * Only the CLI flag reaches here, never relayed content, and queued messages are never typed with it. If an agent
 * is in the pane, or appears before typing, the message takes the queued agent path instead.
 */
export async function sendToShell(d: Deps, target: string, text: string, from: string): Promise<SendResult> {
  const paneId = resolveTarget(d, target);
  if ((await d.herdr.status(paneId)) !== "shell") return send(d, target, text, from);
  if (await d.herdr.typeIntoShell(paneId, text)) return "DELIVERED";
  d.store.enqueue(paneId, { at: d.now(), from, text });
  return "QUEUED";
}

/**
 * Delivers a pane's queued messages as one batch. `held`: only messages held after an ambiguous delivery are left;
 * they wait for a person or the lead (#89). Throws DeliveryUncertain, having recorded the attempt on the queued
 * messages, when the batch may already have reached the pane.
 */
export async function flushInbox(d: Deps, paneId: string): Promise<"delivered" | "queued" | "no-agent" | "held"> {
  const all = d.store.queued(paneId);
  if (all.length === 0) return "delivered";
  const queued = all.filter((m) => m.attempt?.state !== "ambiguous");
  if (queued.length === 0) return "held";
  const status = await d.herdr.status(paneId);
  if (status === "gone") throw new Refusal(`pane ${paneId} is gone; ${all.length} message(s) kept in its inbox`);
  if (status === "shell") return "no-agent";
  if (!READY_TO_READ.includes(status)) return "queued";
  const typed = queued.filter((m) => m.attempt?.state === "typed");
  if (typed.length > 0) {
    // An earlier pass typed these and only the Enter failed: press Enter, never type them again (#89).
    if (!(await d.herdr.submitTyped(paneId))) return "no-agent";
    settleInbox(d, paneId, typed);
    // Messages queued after the typed batch were not delivered by this Enter; they wait for the next pass.
    return typed.length === queued.length ? "delivered" : "queued";
  }
  const body =
    queued.length === 1
      ? queued[0]!.text
      : `${queued.length} messages arrived while you were busy:\n\n` +
        queued.map((m, i) => `(${i + 1}) from ${m.from}:\n${m.text}`).join("\n\n");
  try {
    if (!(await d.herdr.deliver(paneId, body))) return "no-agent";
  } catch (e) {
    if (e instanceof DeliveryUncertain) await recordUncertain(d, paneId, queued, e);
    throw e;
  }
  settleInbox(d, paneId, queued);
  return "delivered";
}

/** Re-reads the inbox and drops the batch (delivered) or marks it with the failed attempt; messages queued meanwhile stay. */
function settleInbox(d: Deps, paneId: string, batch: readonly QueuedMessage[], attempt?: DeliveryAttempt): void {
  const left = [...batch];
  const rest = d.store.queued(paneId).flatMap((m) => {
    const i = left.findIndex((b) => b.at === m.at && b.from === m.from && b.text === m.text);
    if (i < 0) return [m];
    left.splice(i, 1);
    return attempt ? [{ ...m, attempt }] : [];
  });
  d.store.saveInbox(paneId, rest);
}

const NOTICE_FROM = "dori-delivery";

/**
 * Records an uncertain delivery on the queued messages. Typed text only waits for its Enter. An ambiguous batch is
 * held and the lead is told once; held messages are never retried, so the notice is never repeated. A notice that
 * itself fails ambiguously is held without another notice, so this cannot loop.
 */
async function recordUncertain(d: Deps, paneId: string, batch: readonly QueuedMessage[], e: DeliveryUncertain): Promise<void> {
  const detail = failureDetail(e);
  settleInbox(d, paneId, batch, { at: d.now(), state: e.typed ? "typed" : "ambiguous", detail });
  if (e.typed || batch.every((m) => m.from === NOTICE_FROM)) return;
  const which = batch.map((m) => `from ${m.from} queued ${new Date(m.at).toISOString()}`).join(", ");
  const text =
    `[DELIVERY-AMBIGUOUS ${paneId}] ${batch.length} message(s) (${which}) may or may not have reached the pane; hc said: ${detail}. ` +
    `Held and not resent. Check the pane; if it did not arrive, send it again with dori send. Then remove the held entry from ${d.store.inboxPath(paneId)}.`;
  try {
    await tellLead(d, text, NOTICE_FROM);
  } catch (err) {
    process.stderr.write(`dori: telling the lead about the ambiguous delivery to ${paneId} failed too (${failureDetail(err)}); the notice is kept in the lead's inbox\n`);
  }
}

/** The lead delivery's result, or undefined when no lead is registered. Throws DeliveryUncertain like sendOrThrow. */
export async function tellLead(d: Deps, text: string, from: string): Promise<"DELIVERED" | "QUEUED" | undefined> {
  if (!d.store.roles().lead) {
    process.stderr.write(`dori: no lead pane registered; message kept only in the lane log\n`);
    return undefined;
  }
  return sendOrThrow(d, "lead", text, from);
}

// ---------- lanes ----------

export async function startLane(
  d: Deps,
  key: string,
  briefFile: string,
  opts: { cwd?: string; workspace?: string } = {},
): Promise<Lane> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const reserved = reservedKey(key);
  if (reserved) throw new Refusal(reserved);
  const existing = d.store.lane(key);
  if (existing && existing.status !== "done" && existing.status !== "lost") {
    // A lane whose terminal finished or vanished is lost, not open: record that, then start the key afresh.
    if (existing.status === "ready" || await d.herdr.status(existing.paneId) !== "gone") {
      throw new Refusal(`lane ${key} is already open in ${existing.paneId}`);
    }
    await markLost(d, existing);
  }
  const cwd = resolve(opts.cwd ?? process.cwd());
  const briefPath = d.store.briefPath(key);
  const footer = prompt("lane-footer.md", { key, dori: d.doriCmd });
  await Bun.write(briefPath, `${readFileSync(briefFile, "utf8").trimEnd()}\n\n${footer}`);

  const workspace = opts.workspace ?? process.env["HERDR_WORKSPACE_ID"];
  const env = { DORI_LANE: key, DORI_HOME: d.store.root };
  const pane = workspace
    ? await d.herdr.createTab(key, cwd, workspace, env)
    : await d.herdr.createTab(key, cwd, (await d.herdr.createWorkspace("dori", cwd)).workspaceId, env);
  const kickoff = `Read your brief at ${briefPath} and execute it. Your lane key is ${key}.`;
  await d.herdr.run(pane.paneId, `${d.agentCmd} ${shq(kickoff)}`);

  const now = d.now();
  const lane: Lane = {
    key, paneId: pane.paneId, tabId: pane.tabId, brief: briefPath, cwd,
    status: "working", createdAt: now, lastActivityAt: now, nudges: 0,
    log: [{ at: now, kind: "start", text: briefFile }],
  };
  d.store.saveLane(lane);
  await tellLead(d, `[START ${key}] lane opened in ${pane.paneId}`, key);
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

export async function report(d: Deps, key: string, text: string, status?: "working" | "waiting"): Promise<SendResult | undefined> {
  const lane = openLane(d, key);
  const now = d.now();
  lane.log.push({ at: now, kind: "report", text });
  lane.lastActivityAt = now;
  lane.nudges = 0;
  if (status) lane.status = status;
  d.store.saveLane(lane);
  return settled(tellLead(d, `[REPORT ${key}${status === "waiting" ? " WAITING" : ""}] ${text}`, key));
}

export async function ready(d: Deps, key: string, text: string, evidence: readonly string[]): Promise<SendResult | undefined> {
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
  d.usage.record({
    name: "dori.lane_ready",
    evidence_count: Math.min(evidence.length, 100),
    lane_minutes: Math.min(Math.floor((now - lane.createdAt) / 60_000), 10_080),
  });
  return sent;
}

/**
 * Closes a lane. Without `abandon`, only a READY lane closes. With it, the lead closes a lane that will never report
 * READY (wedged, finished or lost), stopping its terminal if one still runs; the reason is kept in the lane's log.
 */
export async function done(d: Deps, key: string, abandon?: { note: string }): Promise<void> {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (abandon) {
    if (!abandon.note.trim()) throw new Refusal("--abandon needs a --note saying why");
    if (lane.status === "done") throw new Refusal(`lane ${key} is already done`);
  } else if (lane.status !== "ready") {
    throw new Refusal(`lane ${key} is ${lane.status}, not ready: no final answer recorded (close it anyway with --abandon --note WHY)`);
  }
  const st = await d.herdr.status(lane.paneId);
  if (!abandon && (st === "working" || st === "blocked")) throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
  if (st !== "gone") await d.herdr.close(lane.paneId);
  lane.status = "done";
  lane.closedAt = d.now();
  lane.log.push({ at: lane.closedAt, kind: "done", text: abandon ? `abandoned without READY: ${abandon.note}` : "closed by lead" });
  d.store.saveLane(lane);
}

/** A lane whose terminal finished or vanished without READY: recorded as lost and reported to the lead as [LOST]. */
async function markLost(d: Deps, lane: Lane): Promise<void> {
  lane.status = "lost";
  lane.closedAt = d.now();
  lane.log.push({ at: lane.closedAt, kind: "lost", text: "terminal finished or disappeared without READY" });
  d.store.saveLane(lane);
  await tellLead(d, `[LOST ${lane.key}] terminal ${lane.paneId} finished or closed without a final answer`, "duty");
}

/**
 * Retires the terminal and app tab of every lane done or lost at least tabCloseDelayMs ago, once. A lane restarted
 * since is working again and has no closedAt. The lead's, duty's and the loops' terminals are never touched, and the
 * backend keeps any terminal it cannot prove is this lane's and any tab another live terminal still uses.
 */
async function retireClosedLanes(d: Deps, events: DutyEvent[]): Promise<void> {
  if (d.tabCloseDelayMs <= 0) return;
  const kept = new Set([...Object.values(d.store.roles()), ...d.store.loops()]);
  for (const lane of d.store.lanes()) {
    if ((lane.status !== "done" && lane.status !== "lost") || lane.closedAt === undefined || lane.retiredAt !== undefined) continue;
    const now = d.now();
    if (now - lane.closedAt < d.tabCloseDelayMs) continue;
    try {
      const text = kept.has(lane.paneId)
        ? `kept: terminal ${lane.paneId} is the lead's, duty's or a loop's`
        : await d.herdr.retire(lane.paneId, lane.key);
      lane.retiredAt = now;
      lane.log.push({ at: now, kind: "retired", text });
      d.store.saveLane(lane);
      events.push({ lane: lane.key, action: "retired", detail: text });
    } catch (e) {
      // Tried again on the next pass; one lane's failure never stops the others.
      events.push({ lane: lane.key, action: "retire-failed", detail: failureDetail(e) });
    }
  }
}

// ---------- duty loop ----------

export type DutyEvent = { lane?: string; pane?: string; action: string; detail?: string };

/** A short one-line reason. A CommandError message carries the whole argv (the queued text), so use the command's own output. */
function failureDetail(e: unknown): string {
  if (e instanceof DeliveryUncertain) e = e.failure;
  const raw = e instanceof CommandError ? e.result.stderr || e.result.stdout : e instanceof Error ? e.message : String(e);
  const first = raw.trim().split("\n")[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
}

/** One proactive pass: flush inboxes of panes that became idle, nudge silent lanes, escalate, detect lost panes. */
export async function dutyTick(d: Deps): Promise<DutyEvent[]> {
  // Kill switch: a stopped duty loop delivers, nudges and escalates nothing. Queued messages wait for the resume.
  const stop = d.store.stop("duty");
  if (stop) return [{ action: "stopped", detail: stop.reason }];
  const events: DutyEvent[] = [];
  for (const paneId of d.store.inboxPanes()) {
    try {
      const result = await flushInbox(d, paneId);
      if (result === "delivered") events.push({ pane: paneId, action: "flushed" });
      if (result === "no-agent") {
        events.push({ pane: paneId, action: "inbox-held", detail: `no agent in front; ${d.store.queued(paneId).length} message(s) kept` });
      }
      // Held after an ambiguous delivery (#89): shown on every pass, resent never; the lead was told once.
      const held = d.store.queued(paneId).filter((m) => m.attempt?.state === "ambiguous").length;
      if (held > 0) events.push({ pane: paneId, action: "delivery-ambiguous", detail: `${held} message(s) held, not resent` });
    } catch (e) {
      // One pane's failed delivery must never kill the loop for every other pane and lane.
      if (e instanceof Refusal) events.push({ pane: paneId, action: "inbox-target-gone" });
      else if (e instanceof DeliveryUncertain && !e.typed) events.push({ pane: paneId, action: "delivery-ambiguous", detail: failureDetail(e) });
      else events.push({ pane: paneId, action: "flush-failed", detail: failureDetail(e) });
    }
  }
  for (const lane of d.store.lanes()) {
    if (lane.status !== "working" && lane.status !== "waiting") continue;
    try {
      const st = await d.herdr.status(lane.paneId);
      const now = d.now();
      if (st === "gone") {
        await markLost(d, lane);
        events.push({ lane: lane.key, action: "lost" });
        continue;
      }
      if (st === "working") {
        lane.lastActivityAt = now;
        d.store.saveLane(lane);
        continue;
      }
      if (lane.status === "waiting" || st === "blocked") continue;
      const idleMin = (now - lane.lastActivityAt) / 60_000;
      const due = NUDGE_MINUTES[lane.nudges];
      if (due === undefined || idleMin < due) continue;
      lane.nudges += 1;
      lane.log.push({ at: now, kind: "nudge", text: `idle ${Math.floor(idleMin)} min` });
      d.store.saveLane(lane);
      if (lane.nudges < NUDGE_MINUTES.length) {
        await sendOrThrow(d, lane.key, prompt("nudge.md", { key: lane.key, minutes: String(Math.floor(idleMin)), dori: d.doriCmd }), "duty");
        events.push({ lane: lane.key, action: `nudge-${lane.nudges}` });
      } else {
        await tellLead(d, `[ESCALATE ${lane.key}] idle ${Math.floor(idleMin)} min with no READY after ${lane.nudges - 1} nudges`, "duty");
        events.push({ lane: lane.key, action: "escalated" });
      }
    } catch (e) {
      // One lane's failed status read or delivery must not end the loop for the other lanes.
      events.push({ lane: lane.key, action: "lane-failed", detail: failureDetail(e) });
    }
  }
  await retireClosedLanes(d, events);
  const count = (pred: (a: string) => boolean) => events.filter((e) => pred(e.action)).length;
  d.usage.touch();
  d.usage.duty({
    ticks: 1,
    flushed: count((a) => a === "flushed"),
    nudges: count((a) => a.startsWith("nudge-")),
    escalations: count((a) => a === "escalated"),
    lost: count((a) => a === "lost"),
  });
  return events;
}

// ---------- review + merge gate ----------

export type PrRef = { repo: string; number: number; id: string };

export function parsePr(s: string): PrRef {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (!m) throw new Refusal(`PR must look like owner/repo#123, got ${s}`);
  return { repo: m[1]!, number: Number(m[2]), id: s };
}

async function gh(d: Deps, argv: readonly string[]): Promise<string> {
  const r = await d.exec("gh", argv);
  if (r.code !== 0) throw new Error(`gh ${argv.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export async function headSha(d: Deps, pr: PrRef): Promise<string> {
  const out = JSON.parse(await gh(d, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "headRefOid"]));
  return String(out.headRefOid);
}

/** Runs a fresh, non-interactive reviewer session pinned to the PR head and records its verdict as a receipt. */
export async function review(d: Deps, prId: string, model?: string): Promise<{ verdict: "CLEAR" | "BLOCK"; sha: string; review: string }> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  const text = prompt("review.md", { pr: pr.id, repo: pr.repo, number: String(pr.number), sha });
  // A run without a VERDICT line is tried once more; its output is kept so the cause can be read.
  let found: { verdict: "CLEAR" | "BLOCK"; full: string } | undefined;
  for (let attempt = 1; attempt <= 2 && !found; attempt++) {
    const directory = d.store.createReviewAttempt(pr.id, sha);
    const session = join(directory, "session.jsonl");
    const argv = ["-p", "--session", session, ...(model ? ["--model", model] : []), text];
    const startedAt = d.now();
    const res = await d.exec(d.agentCmd, argv, { timeoutMs: d.reviewTimeoutMs });
    const diagnostics = d.store.saveReviewAttempt(directory, {
      pr: pr.id, sha, attempt, model: model ?? "default", session,
      startedAt, finishedAt: d.now(), code: res.code, timedOut: res.timedOut ?? false,
      stdout: res.stdout, stderr: res.stderr,
    });
    process.stderr.write(`dori: reviewer attempt ${attempt} diagnostics: ${diagnostics}\n`);
    const out = res.stdout.trim();
    const last = [...res.stdout.matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)].at(-1);
    if (res.timedOut) {
      // omo -p prints its whole answer only once the review is finished, and can then stay alive until the deadline
      // (#302): a VERDICT already in that output is a finished review. A run killed before any verdict is not retried.
      if (!last) {
        const kept = out ? `; its output so far: ${d.store.saveReviewOutput(pr.id, sha, out)}` : "";
        throw new Error(`reviewer timed out after ${d.reviewTimeoutMs / 60_000} min; no receipt written; diagnostics: ${diagnostics}${kept}`);
      }
      process.stderr.write(`dori: the reviewer of ${pr.id} printed its VERDICT but kept running until the ${d.reviewTimeoutMs / 60_000} min deadline; receipt written from that output\n`);
    } else if (res.code !== 0) throw new Error(`reviewer exited ${res.code}: ${res.stderr.trim()}; diagnostics: ${diagnostics}`);
    if (last) found = { verdict: last[1] as "CLEAR" | "BLOCK", full: out };
    else if (attempt === 2) {
      throw new Error(`reviewer printed no VERDICT line twice; no receipt written; diagnostics: ${diagnostics}; its output: ${d.store.saveReviewOutput(pr.id, sha, out)}`);
    } else d.store.saveReviewOutput(pr.id, sha, out);
  }
  const { verdict, full } = found!;
  // The verdict summary and the most severe findings come first, the VERDICT line last: keep both ends.
  const summary = full.length <= 4000 ? full : `${full.slice(0, 2000)}\n[... see the full review ...]\n${full.slice(-1960)}`;
  const receipt = d.store.saveReceipt({ pr: pr.id, sha, verdict, model: model ?? "default", at: d.now(), summary }, full);
  d.usage.record({ name: "dori.review_completed", verdict });
  return { verdict, sha, review: receipt.review };
}

type Check = { name: string; bucket: string };
const NATIVE_QUEUE_REPO = "formaengine/forma-rs";

/** Require exact-head CLEAR; Forma delegates landing verification to its trusted native queue, other repos require green checks. */
export async function mergeGate(d: Deps, prId: string, opts: { dryRun?: boolean } = {}): Promise<string> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  const refused = await gateRefusal(d, pr, sha);
  if (refused) {
    if (!opts.dryRun) d.usage.record({ name: "dori.merge_decided", outcome: refused[0] });
    throw new Refusal(`MERGE_REFUSED ${refused[1]}`);
  }
  if (pr.repo.toLowerCase() === NATIVE_QUEUE_REPO) {
    if (!d.landingBackend) throw new Refusal("MERGE_REFUSED native landing requires an explicit trusted queue backend");
    if (opts.dryRun) throw new Refusal("MERGE_REFUSED native dry-run is unavailable: landing verification requires the native queue");
  }
  if (opts.dryRun) return `MERGE_OK ${pr.id} head=${sha} (dry run)`;
  if (d.landingBackend) {
    if (await headSha(d, pr) !== sha) throw new Refusal("MERGE_REFUSED head moved during landing admission");
    if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Refusal("MERGE_REFUSED landing backend requires a full head SHA");
    const backend = pr.repo.toLowerCase() === NATIVE_QUEUE_REPO && (d.formaQueueBootstrap ||
      d.landingBackend.some((arg) => /(^|\/)(python|pypy)(\d+(\.\d+)*)?$/i.test(arg)) ||
      d.landingBackend.some((arg) => arg.toLowerCase().includes(".atomic/workflows/dori-landing.py")))
      ? await attestBootstrap(d.exec, d.landingBackend, { pin: d.formaQueueBootstrap, repo: pr.repo, pr: pr.number, head: sha })
      : d.landingBackend;
    const [command, ...argv] = backend;
    if (!command) throw new Refusal("MERGE_REFUSED landing backend has no executable");
    const result = await d.exec(command, [...argv, "--repo", pr.repo, "--pr", String(pr.number), "--expected-head", sha]);
    if (result.timedOut || result.code !== 0) {
      const reason = result.stderr.trim().slice(-2000);
      throw new Refusal(`MERGE_REFUSED landing backend ${result.timedOut ? "timed out" : `exited ${result.code}`}${reason ? `: ${reason}` : ""}`);
    }
    let receipt: unknown;
    try {
      receipt = JSON.parse(result.stdout);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      throw new Refusal("MERGE_REFUSED landing backend must return exactly one JSON object");
    }
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt) ||
        !("repo" in receipt) || receipt.repo !== pr.repo ||
        !("pr" in receipt) || receipt.pr !== pr.number ||
        !("expectedHead" in receipt) || receipt.expectedHead !== sha || !("status" in receipt)) {
      throw new Refusal("MERGE_REFUSED landing backend receipt does not match request identity");
    }
    switch (receipt.status) {
      case "queued":
        return `QUEUED ${pr.id} head=${sha}`;
      case "landed":
        if (!("landedHead" in receipt) || typeof receipt.landedHead !== "string" || !/^[a-f0-9]{40}$/i.test(receipt.landedHead) ||
            !("landedTree" in receipt) || typeof receipt.landedTree !== "string" || !/^[a-f0-9]{40}$/i.test(receipt.landedTree) ||
            !("receipt" in receipt) || typeof receipt.receipt !== "string" || receipt.receipt.trim().length === 0) {
          throw new Refusal("MERGE_REFUSED landing backend landed receipt requires landedHead, landedTree and queue evidence");
        }
        d.usage.record({ name: "dori.merge_decided", outcome: "merged" });
        return `MERGED ${pr.id} head=${sha} landedHead=${receipt.landedHead} landedTree=${receipt.landedTree} receipt=${receipt.receipt}`;
      default:
        throw new Refusal("MERGE_REFUSED landing backend returned an unknown status");
    }
  }
  await gh(d, ["pr", "merge", String(pr.number), "--repo", pr.repo, "--squash", "--match-head-commit", sha]);
  d.usage.record({ name: "dori.merge_decided", outcome: "merged" });
  return `MERGED ${pr.id} head=${sha}`;
}

async function gateRefusal(d: Deps, pr: PrRef, sha: string): Promise<[MergeOutcome, string] | undefined> {
  const receipt = d.store.receipt(pr.id, sha);
  if (!receipt) return ["no_receipt", `no review receipt at head ${sha.slice(0, 12)} (run: dori review ${pr.id})`];
  if (receipt.verdict !== "CLEAR") return ["review_block", `review at ${sha.slice(0, 12)} is ${receipt.verdict}`];
  if (pr.repo.toLowerCase() === NATIVE_QUEUE_REPO) return undefined;
  const checksRes = await d.exec("gh", ["pr", "checks", String(pr.number), "--repo", pr.repo, "--json", "name,bucket"]);
  const checks: Check[] = checksRes.stdout.trim().startsWith("[") ? JSON.parse(checksRes.stdout) : [];
  if (checks.length === 0) return ["no_checks", "no checks reported: an empty check list is never green"];
  const bad = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  if (bad.length > 0) return ["checks_red", `checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(", ")}`];
  if (!checks.some((c) => c.bucket === "pass")) return ["checks_all_skipped", "every check was skipped"];
  return undefined;
}

export const ROLES: readonly Role[] = ["lead", "duty"];
