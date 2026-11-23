import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendQueue, inboxFile, inboxRefs, readQueue, writeQueue } from "./inbox-files.ts";
import { takeInboxLock } from "./inbox-lock.ts";
import { refFromText, refText, sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import {
  KEEP_RUNS,
  KEY_RE,
  type Item,
  type Lane,
  type LoopRun,
  type QueuedMessage,
  type ReviewReceipt,
  type Role,
} from "./store-types.ts";

export type { HostLoad } from "./store-types.ts";

/** A lane file as any binary wrote it: one written before session refs existed has only `paneId`. */
type StoredLane = Omit<Lane, "sessionRef"> & { sessionRef?: SessionRef };

/** Reads a record without `sessionRef` as the hc terminal its `paneId` names; the same input always gives the same lane. */
const upgrade = (raw: StoredLane): Lane =>
  raw.sessionRef !== undefined ? (raw as Lane) : { ...raw, sessionRef: { runtime: "hc", id: raw.paneId } };

const checkedId = (id: string): string => {
  if (!KEY_RE.test(id)) throw new Error(`invalid id ${JSON.stringify(id)}: must match ${KEY_RE}`);
  return id;
};

export class Store {
  constructor(readonly root: string = process.env["DORI_HOME"] ?? join(homedir(), ".dori")) {
    for (const d of ["lanes", "inbox", "briefs", "receipts", "backlog", "loop/runs", "duty"])
      mkdirSync(join(root, d), { recursive: true });
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
    const raw = this.readJson<StoredLane>(join(this.root, "lanes", `${key}.json`));
    return raw && upgrade(raw);
  }

  /** Writes `paneId`/`tabId` from `sessionRef` beside it (an hc terminal is its own tab), so an older binary still reads the record. */
  saveLane(lane: Lane): void {
    const { id } = lane.sessionRef;
    this.writeJson(join(this.root, "lanes", `${lane.key}.json`), { ...lane, paneId: id, tabId: id });
  }

  lanes(): Lane[] {
    return readdirSync(join(this.root, "lanes"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.readJson<StoredLane>(join(this.root, "lanes", f)))
      .filter((l): l is StoredLane => l !== undefined)
      .map(upgrade)
      .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  }

  laneBySession(ref: SessionRef): Lane | undefined {
    return this.lanes().find((l) => sameSession(l.sessionRef, ref) && l.status !== "done");
  }

  /** roles.json holds ref strings (refText): bare hc terminal addresses, so an older binary still parses it. */
  roles(): Partial<Record<Role, SessionRef>> {
    const raw = this.readJson<Partial<Record<Role, string>>>(join(this.root, "roles.json")) ?? {};
    return Object.fromEntries(Object.entries(raw).map(([role, text]) => [role, refFromText(text)]));
  }

  setRole(role: Role, ref: SessionRef): void {
    const raw = this.readJson<Partial<Record<Role, string>>>(join(this.root, "roles.json")) ?? {};
    this.writeJson(join(this.root, "roles.json"), { ...raw, [role]: refText(ref) });
  }

  briefPath(key: string): string {
    return join(this.root, "briefs", `${key}.md`);
  }

  inboxPath(ref: SessionRef): string {
    return inboxFile(this.root, ref);
  }

  enqueue(ref: SessionRef, msg: QueuedMessage): void {
    appendQueue(this.inboxPath(ref), msg);
  }

  queued(ref: SessionRef): QueuedMessage[] {
    return readQueue(this.inboxPath(ref));
  }

  saveInbox(ref: SessionRef, msgs: readonly QueuedMessage[]): void {
    writeQueue(this.inboxPath(ref), msgs);
  }

  /**
   * Takes the session's inbox lock (`<inbox>.lock`, created O_EXCL, holding pid, host and time) and returns its release,
   * or undefined while another flush holds it. A lock whose pid is dead on this host, or one from another host (or
   * unreadable) older than INBOX_LOCK_STALE_MS, is taken over: it is renamed aside first, and when what was renamed is not the lock judged stale (another
   * process took it over in between), it is put back and the lock counts as held.
   */
  lockInbox(ref: SessionRef, now: number): (() => void) | undefined {
    return takeInboxLock(`${this.inboxPath(ref)}.lock`, now);
  }

  /** Sessions with queued messages. */
  inboxPanes(): SessionRef[] {
    return inboxRefs(this.root).filter((r) => this.queued(r).length > 0);
  }

  private receiptPath(pr: string, sha: string): string {
    return join(this.root, "receipts", `${pr.replaceAll("/", "__").replace("#", "_")}@${sha}.json`);
  }

  saveReceipt(r: ReviewReceipt): void {
    this.writeJson(this.receiptPath(r.pr, r.sha), r);
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

  /** The single-instance lock of the hourly loop (`loop/lock`) or of the duty loop (`duty/lock`). */
  lockPath(of: "loop" | "duty"): string {
    return join(this.root, of, "lock");
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
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_RUNS))) rmSync(join(dir, f), { force: true });
    return name;
  }

  runs(): string[] {
    return readdirSync(this.loopPath("runs"))
      .filter((f) => f.endsWith(".json"))
      .sort();
  }
}
