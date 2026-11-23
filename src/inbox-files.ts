import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionRef } from "./runtime/types.ts";
import type { QueuedMessage } from "./store-types.ts";

// Inbox files: one JSONL queue per session, named by its hc terminal address (`t7.jsonl`).

const SUFFIX = ".jsonl";

export function inboxFile(root: string, ref: SessionRef): string {
  return join(root, "inbox", `${ref.id}${SUFFIX}`);
}

/** Every session that has an inbox file, empty or not. */
export const inboxRefs = (root: string): SessionRef[] =>
  readdirSync(join(root, "inbox"))
    .filter((f) => f.endsWith(SUFFIX))
    .map((f) => ({ runtime: "hc", id: f.slice(0, -SUFFIX.length) }));

export function readQueue(path: string): QueuedMessage[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as QueuedMessage);
}

export const writeQueue = (path: string, msgs: readonly QueuedMessage[]): void =>
  writeFileSync(path, msgs.map((m) => `${JSON.stringify(m)}\n`).join(""));

export const appendQueue = (path: string, msg: QueuedMessage): void => appendFileSync(path, `${JSON.stringify(msg)}\n`);
