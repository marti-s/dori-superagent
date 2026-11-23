import type { SessionRef } from "./runtime/types.ts";

export type LaneStatus = "working" | "waiting" | "ready" | "done" | "lost";

/**
 * One lane record. `sessionRef` is the hc terminal it runs in; `paneId`/`tabId` are written beside it (both the
 * terminal's address) so an older binary still reads the file.
 */
export type Lane = {
  key: string;
  sessionRef: SessionRef;
  paneId: string;
  tabId: string;
  brief: string;
  cwd: string;
  status: LaneStatus;
  createdAt: number;
  lastActivityAt: number;
  nudges: number;
  final?: { text: string; evidence: string[]; at: number };
  /** When the lane became done or lost; its terminal and tab are retired a configured delay later. */
  closedAt?: number;
  /** When the duty loop retired the lane's terminal and tab (or decided to leave them). */
  retiredAt?: number;
  log: { at: number; kind: "start" | "report" | "ready" | "nudge" | "done" | "lost" | "retired"; text: string }[];
};

/** The sessions `dori up` opens; roles.json maps each to a ref string (an hc terminal address, `t7`). */
export type Role = "lead" | "duty" | "duty-loop" | "hourly-loop";

/**
 * A delivery that failed after the message may have reached the pane (#89). `typed`: the text is in the pane's input
 * and only Enter is retried; `agent` and `pgid` record which agent it was typed into (#108, see AgentIdentity).
 * `ambiguous`: it may or may not have arrived; it is held, never resent automatically.
 */
export type DeliveryAttempt = {
  at: number;
  state: "typed" | "ambiguous";
  detail?: string;
  agent?: string;
  pgid?: number;
};

/** A flush lock from another host (or an unreadable one) older than this is taken over; on this host only a dead pid frees it (#108). */
export const INBOX_LOCK_STALE_MS = 60_000;

export type QueuedMessage = { at: number; from: string; text: string; attempt?: DeliveryAttempt };

export type ReviewReceipt = {
  pr: string;
  sha: string;
  verdict: "CLEAR" | "BLOCK";
  model: string;
  at: number;
  /** The start and the end of the review, at most 4000 characters; the whole review is in `review`. */
  summary: string;
  /** Path of the file holding the reviewer's full output. */
  review: string;
};

export type ItemStatus = "open" | "running" | "done" | "dropped";

/** One backlog entry. Its id is the lane key the hourly loop starts it under. */
export type Item = {
  id: string;
  title: string;
  brief: string;
  cwd: string;
  priority: number;
  status: ItemStatus;
  decision?: string;
  askedAt?: number;
  remindedAt?: number;
  attempts: number;
  startFailures?: number;
  source?: string;
  createdAt: number;
  updatedAt: number;
  log: { at: number; kind: "add" | "start" | "reopen" | "done" | "drop" | "ask" | "remind" | "decide"; text: string }[];
};

export type HostLoad = { load1: number; cores: number; memFreePct: number };

export type LoopRun = {
  at: number;
  skipped?: string;
  status?: {
    lanes: number;
    maxLanes: number;
    adhoc: string[];
    items: { open: number; decide: number; running: number };
    host: HostLoad;
  };
  synced: string[];
  findings: string[];
  started: string[];
  held: string[];
  asked: string[];
};

export const KEEP_RUNS = 168;
export const KEY_RE = /^[a-z][a-z0-9-]{1,40}$/;
/** Role names are send targets, and resolveTarget tries roles first, so a lane with one of these keys could never be reached. */
export const RESERVED_KEYS: readonly Role[] = ["lead", "duty", "duty-loop", "hourly-loop"];
/** Refusal text for a reserved lane key, or undefined. Keys are lowercase-only (KEY_RE), so the exact match is the whole check. */
export const reservedKey = (key: string): string | undefined =>
  (RESERVED_KEYS as readonly string[]).includes(key) ? `lane key "${key}" is reserved for the ${key} role` : undefined;
