import { mkdirSync, readdirSync, existsSync, appendFileSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LaneStatus = "working" | "waiting" | "ready" | "done" | "lost";

export type Lane = {
  key: string;
  paneId: string;
  tabId: string;
  brief: string;
  cwd: string;
  status: LaneStatus;
  createdAt: number;
  lastActivityAt: number;
  nudges: number;
  final?: { text: string; evidence: string[]; at: number };
  log: { at: number; kind: "start" | "report" | "ready" | "nudge" | "done" | "lost"; text: string }[];
};

export type Role = "lead" | "duty";

/**
 * A delivery that failed after the message may have reached the pane (#89). `typed`: the text is in the pane's input
 * and only Enter is retried. `ambiguous`: it may or may not have arrived; it is held, never resent automatically.
 */
export type DeliveryAttempt = { at: number; state: "typed" | "ambiguous"; detail?: string };

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
export const RESERVED_KEYS: readonly Role[] = ["lead", "duty"];
/** Refusal text for a reserved lane key, or undefined. Keys are lowercase-only (KEY_RE), so the exact match is the whole check. */
export const reservedKey = (key: string): string | undefined =>
  (RESERVED_KEYS as readonly string[]).includes(key) ? `lane key "${key}" is reserved for the ${key} role` : undefined;

const checkedId = (id: string): string => {
  if (!KEY_RE.test(id)) throw new Error(`invalid id ${JSON.stringify(id)}: must match ${KEY_RE}`);
  return id;
};

export class Store {
  constructor(readonly root: string = process.env["DORI_HOME"] ?? join(homedir(), ".dori")) {
    for (const d of ["lanes", "inbox", "briefs", "receipts", "backlog", "loop/runs", "duty"]) mkdirSync(join(root, d), { recursive: true });
  }

  private readJson<T>(path: string): T | undefined {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
  }

  private writeJson(path: string, value: unknown): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, path);
  }

  lane(key: string): Lane | undefined {
    return this.readJson<Lane>(join(this.root, "lanes", `${key}.json`));
  }

  saveLane(lane: Lane): void {
    this.writeJson(join(this.root, "lanes", `${lane.key}.json`), lane);
  }

  lanes(): Lane[] {
    return readdirSync(join(this.root, "lanes"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.readJson<Lane>(join(this.root, "lanes", f)))
      .filter((l): l is Lane => l !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  }

  laneByPane(paneId: string): Lane | undefined {
    return this.lanes().find((l) => l.paneId === paneId && l.status !== "done");
  }

  roles(): Partial<Record<Role, string>> {
    return this.readJson(join(this.root, "roles.json")) ?? {};
  }

  setRole(role: Role, paneId: string): void {
    this.writeJson(join(this.root, "roles.json"), { ...this.roles(), [role]: paneId });
  }

  briefPath(key: string): string {
    return join(this.root, "briefs", `${key}.md`);
  }

  inboxPath(paneId: string): string {
    return join(this.root, "inbox", `${paneId.replaceAll(":", "_")}.jsonl`);
  }

  enqueue(paneId: string, msg: QueuedMessage): void {
    appendFileSync(this.inboxPath(paneId), JSON.stringify(msg) + "\n");
  }

  queued(paneId: string): QueuedMessage[] {
    const p = this.inboxPath(paneId);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as QueuedMessage);
  }

  saveInbox(paneId: string, msgs: readonly QueuedMessage[]): void {
    writeFileSync(this.inboxPath(paneId), msgs.map((m) => JSON.stringify(m) + "\n").join(""));
  }

  inboxPanes(): string[] {
    return readdirSync(join(this.root, "inbox"))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length).replaceAll("_", ":"))
      .filter((p) => this.queued(p).length > 0);
  }

  private receiptPath(pr: string, sha: string, ext = "json"): string {
    return join(this.root, "receipts", `${pr.replaceAll("/", "__").replace("#", "_")}@${sha}.${ext}`);
  }

  /** Writes the reviewer's full output beside the receipt, then the receipt pointing at it. */
  saveReceipt(r: Omit<ReviewReceipt, "review">, fullText: string): ReviewReceipt {
    const review = this.receiptPath(r.pr, r.sha, "md");
    const tmp = `${review}.${process.pid}.tmp`;
    writeFileSync(tmp, fullText.endsWith("\n") ? fullText : `${fullText}\n`);
    renameSync(tmp, review);
    const receipt = { ...r, review };
    this.writeJson(this.receiptPath(r.pr, r.sha), receipt);
    return receipt;
  }

  receipt(pr: string, sha: string): ReviewReceipt | undefined {
    return this.readJson(this.receiptPath(pr, sha));
  }

  // ---------- backlog ----------

  itemBrief(id: string): string {
    return join(this.root, "backlog", `${checkedId(id)}.md`);
  }

  item(id: string): Item | undefined {
    return this.readJson<Item>(join(this.root, "backlog", `${checkedId(id)}.json`));
  }

  saveItem(item: Item): void {
    this.writeJson(join(this.root, "backlog", `${checkedId(item.id)}.json`), item);
  }

  items(): Item[] {
    return readdirSync(join(this.root, "backlog"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.readJson<Item>(join(this.root, "backlog", f)))
      .filter((i): i is Item => i !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  // ---------- hourly loop ----------

  loopPath(name: string): string {
    return join(this.root, "loop", name);
  }

  /** The kill switch of the hourly loop (`loop/stop`) or of the duty loop (`duty/stop`). */
  stop(of: "loop" | "duty" = "loop"): { at: number; reason: string } | undefined {
    return this.readJson(join(this.root, of, "stop"));
  }

  setStop(at: number, reason: string, of: "loop" | "duty" = "loop"): void {
    this.writeJson(join(this.root, of, "stop"), { at, reason });
  }

  clearStop(of: "loop" | "duty" = "loop"): void {
    rmSync(join(this.root, of, "stop"), { force: true });
  }

  lastRun(): LoopRun | undefined {
    return this.readJson(this.loopPath("last-run.json"));
  }

  /** Writes the run record and the last-run stamp, keeping the newest KEEP_RUNS records. Pass `name` to rewrite a record. */
  saveRun(run: LoopRun, name?: string): string {
    const dir = this.loopPath("runs");
    if (name === undefined) {
      const stem = new Date(run.at).toISOString().replaceAll(":", "-");
      name = `${stem}.json`;
      for (let n = 2; existsSync(join(dir, name)); n++) name = `${stem}-${n}.json`;
    }
    this.writeJson(join(dir, name), run);
    this.writeJson(this.loopPath("last-run.json"), run);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_RUNS))) rmSync(join(dir, f), { force: true });
    return name;
  }

  runs(): string[] {
    return readdirSync(this.loopPath("runs")).filter((f) => f.endsWith(".json")).sort();
  }
}
