import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import type { SessionRef } from "../../../../src/runtime/types.ts";
import type { BudgetLimits } from "./supervision-observe.ts";

export const LANE_KEY = /^[a-z0-9][a-z0-9._-]{1,60}$/;
/**
 * `lead` names the lead, never a lane: records the lead writes (lessons with `lane: "lead"`) and lead-only checks tell
 * the two apart by this key, so launch and adopt refuse it. LANE_KEY stays as it is because those records still carry it,
 * and keys are lowercase-only, so the exact match is the whole check.
 */
export const RESERVED_LANE_KEY = "lead";

export type LaneStatus = "working" | "paused" | "done-claimed" | "verified-done" | "not-done" | "closed";
export type Claim = { readonly at: string; readonly evidence: string; readonly emitted?: boolean };
export type Objection = { readonly at: string; readonly reasons: readonly string[] };
export type HistoryEntry = { readonly at: string; readonly status: LaneStatus; readonly note: string };

export type Lane = {
  readonly key: string;
  readonly title: string;
  readonly thread: string;
  /** The lane's session: an hc terminal. `pane`/`tab` both mirror its address for older readers. */
  readonly sessionRef?: SessionRef;
  readonly pane?: string | undefined;
  readonly tab?: string;
  readonly session?: string;
  readonly sessionVia?: string;
  readonly brief: string;
  readonly done: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly worktrees?: readonly string[];
  readonly status?: LaneStatus;
  readonly claim?: Claim;
  readonly objection?: Objection;
  readonly history?: readonly HistoryEntry[];
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly lastReplyAt?: number;
  readonly lastNudgeAt?: number;
  readonly lastAutoReplyAt?: number;
  /** The [REPORT] line the freshness sweep last posted, so a stale screen is never posted twice. */
  readonly lastPostedReport?: string | undefined;
  /** The [REPORT] line seen on the previous freshness tick (a line is posted only once it holds across two ticks). */
  readonly lastSeenReport?: string | undefined;
  /** The last held-back freshness outcome, so a quiet lane logs each state change once, not every tick. */
  readonly lastFreshnessNote?: string | undefined;
  /** A paused lane whose pane read working on the previous freshness tick (two in a row is reported, never a resume). */
  readonly pausedSeenWorking?: boolean | undefined;
  /** The status a paused lane had before it was paused; `resume` restores it. */
  readonly pausedFrom?: LaneStatus | undefined;
  readonly reportProtocol?: "jsonl-v1" | undefined;
  readonly budget?: BudgetLimits;
  readonly activityPaths?: readonly string[];
  /** The last supervision failure printed by `freshness`, so the same one is printed once. */
  readonly lastSupervisionError?: string | undefined;
  readonly receipt?: unknown;
};

/** A record as read: one written before session refs existed gains `sessionRef` from its `pane`, an hc terminal address. */
export const upgradeLane = (lane: Lane): Lane =>
  lane.sessionRef || !lane.pane ? lane : { ...lane, sessionRef: { runtime: "hc", id: lane.pane } };

/** The lane's session, whichever way the record was written (or built in memory). */
export const sessionOf = (lane: Lane): SessionRef | undefined => upgradeLane(lane).sessionRef;

/** The fields a lane record stores for a session: the ref itself and the `pane`/`tab` mirror (an hc terminal is its own tab). */
export const sessionFields = (ref: SessionRef): Pick<Lane, "sessionRef" | "pane" | "tab"> => ({
  sessionRef: ref,
  pane: ref.id,
  tab: ref.id,
});

const sameSession = (a: SessionRef | undefined, b: SessionRef): boolean =>
  a !== undefined && a.runtime === b.runtime && a.id === b.id;

export const statusOf = (lane: Lane): LaneStatus => (lane.closedAt ? "closed" : (lane.status ?? "working"));

export const withStatus = (
  lane: Lane,
  status: LaneStatus,
  note: string,
  at: string,
  patch: Partial<Lane> = {},
): Lane => ({
  ...lane,
  ...patch,
  status,
  history: [...(lane.history ?? []), { at, status, note }],
});

export class Registry {
  readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "lanes");
  }

  path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async read(key: string): Promise<Lane | null> {
    const f = Bun.file(this.path(key));
    return (await f.exists()) ? upgradeLane((await f.json()) as Lane) : null;
  }

  // temp file + rename so a concurrent reader never sees a half-written lane
  async write(lane: Lane): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path(lane.key)}.${process.pid}.tmp`;
    await Bun.write(tmp, JSON.stringify(lane, null, 1));
    renameSync(tmp, this.path(lane.key));
  }

  // Reading never creates the lanes directory (dori boot is read-only); write() creates it.
  private files(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(this.dir, f));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  async list(): Promise<Lane[]> {
    const lanes: Lane[] = [];
    for (const f of this.files()) lanes.push(upgradeLane((await Bun.file(f).json()) as Lane));
    return lanes;
  }

  /** Like list(), but a lane file that cannot be read, parsed, or holds no lane key is returned in `unreadable` instead of throwing. */
  async scan(): Promise<{ lanes: Lane[]; unreadable: string[] }> {
    const lanes: Lane[] = [];
    const unreadable: string[] = [];
    for (const f of this.files()) {
      try {
        const lane: unknown = await Bun.file(f).json();
        if (typeof lane !== "object" || lane === null || !("key" in lane) || typeof lane.key !== "string")
          throw new Error("not a lane record");
        lanes.push(upgradeLane(lane as Lane));
      } catch {
        unreadable.push(f);
      }
    }
    return { lanes, unreadable };
  }

  async open(): Promise<Lane[]> {
    return (await this.list()).filter((l) => statusOf(l) !== "closed");
  }

  /**
   * The open lane in session `ref`. A record keyed `lead` (registered before the key was reserved) is never returned, so a
   * session lookup cannot mistake the lead for a lane; that record is still read by its key, listed, and closed by hand.
   */
  async bySession(ref: SessionRef | undefined): Promise<Lane | null> {
    if (!ref) return null;
    return (await this.open()).find((l) => sameSession(l.sessionRef, ref) && l.key !== RESERVED_LANE_KEY) ?? null;
  }
}
