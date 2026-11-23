import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Manifest, type Monitor, monitorCleanup, readMonitorManifests } from "../src/boot-monitors.ts";
import { reconcilePanes } from "../src/reconcile.ts";
import type { Lane, LaneStatus } from "../src/registry.ts";
import { withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

const lane = (key: string, status: LaneStatus = "working", pane = `w1:${key}`): Lane => ({
  key,
  status,
  pane,
  title: key,
  thread: "none",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: new Date(T0).toISOString(),
});

const manifest = (monitors: Monitor[]): Manifest => ({
  path: "/fixture/extensions/terminal/owner.json",
  data: {
    version: 1,
    sessionId: "owner",
    monitors: monitors.map((m) => ({ sessionId: "owner", persistent: true, monitorId: "mon_FIXTURE", ...m })),
  },
});

let state: ReturnType<typeof withState>;

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

test("vanished, live and unassigned panes reconcile without mutating the lane records", () => {
  // Given lanes whose panes are gone, live, or never assigned.
  const lanes = [
    lane("old", "working", "w1:p8"),
    lane("current", "working", "w2:p2"),
    { ...lane("pending"), pane: undefined },
  ];
  const before = JSON.stringify(lanes);
  // When reconciled against the live pane list.
  const result = reconcilePanes(lanes, [
    { ref: { runtime: "hc", id: "w2:p1", group: "w2" } },
    { ref: { runtime: "hc", id: "w2:p2", group: "w2" } },
  ]);
  // Then each lane is classified, unowned panes are listed, and the input is untouched.
  expect(result.lanes.map((l) => l.paneState)).toEqual(["vanished", "live", "unassigned"]);
  expect(result.unregistered).toEqual(["w2:p1"]);
  expect(JSON.stringify(lanes)).toBe(before);
});

test("persistent watches on closed or verified lanes become owner-scoped stop calls", () => {
  // Given watches for closed, verified and still-claimed lanes, plus a non-persistent one.
  const lanes = [lane("closed", "closed"), lane("verified", "verified-done"), lane("claimed", "done-claimed")];
  const input = manifest([
    { command: "dori watch closed", monitorId: "mon_CLOSED" },
    { command: "hc read w1:verified", monitorId: "mon_VERIFIED" },
    { command: "dori watch claimed", monitorId: "mon_CLAIMED" },
    { command: "dori watch closed", monitorId: "mon_EPHEMERAL", persistent: false },
  ]);
  // When cleanup candidates are computed.
  const result = monitorCleanup(lanes, [input]);
  // Then only persistent watches of finished lanes are listed, with the owner's exact stop call.
  expect(result.map((m) => m.monitorId)).toEqual(["mon_CLOSED", "mon_VERIFIED"]);
  expect(result[0]?.stop).toBe('kill_bash({"bash_id":"mon_CLOSED"})');
  expect(result[0]?.sessionId).toBe("owner");
  expect(result[0]?.metadata).toBe(input.path);
});

test("shared, prefix-matched, unknown and foreign-owner watches are preserved", () => {
  // Given a closed lane whose key is a prefix of an active one, and watches of every risky shape.
  const lanes = [lane("api", "closed"), lane("api-release"), lane("closed", "closed")];
  const result = monitorCleanup(lanes, [
    manifest([
      { command: "dori watch api-release", monitorId: "mon_ACTIVE" },
      { command: "dori watch closed api-release", monitorId: "mon_SHARED" },
      { description: "unrelated presence", command: "bun presence.ts", monitorId: "mon_UNKNOWN" },
      { command: "dori watch closed", sessionId: "other", monitorId: "mon_WRONGOWNER" },
    ]),
  ]);
  // Then none is offered for cleanup.
  expect(result).toEqual([]);
});

test("an active lane named after a colon or before a period or colon still keeps a shared watch", () => {
  // Given a closed lane, an active one, and a closed key that appears only inside a dotted name.
  const lanes = [lane("closed", "closed"), lane("api-release"), lane("v2", "closed")];
  const result = monitorCleanup(lanes, [
    manifest([
      { command: "dori watch closed", description: "closed reports; lane:api-release", monitorId: "mon_COLON" },
      { command: "dori watch closed", description: "closed reports, then api-release.", monitorId: "mon_PERIOD" },
      { command: "dori watch closed", path: "/logs/api-release: both", monitorId: "mon_TRAILCOLON" },
      { command: "dori watch api.v2", monitorId: "mon_DOTTED" },
      { command: "dori watch closed", monitorId: "mon_CLOSED" },
    ]),
  ]);
  // Then only the watch naming nothing but the closed lane is offered.
  expect(result.map((m) => m.monitorId)).toEqual(["mon_CLOSED"]);
});

test("a common-word key ties a watch to its lane only as a command or target token, never in prose or a path", () => {
  // Given a closed lane keyed "docs" and watches that name it in prose, in a path, as a token and by pane.
  const lanes = [lane("docs", "closed")];
  const result = monitorCleanup(lanes, [
    manifest([
      { description: "CI for the docs site on main", command: "gh run watch 4242", monitorId: "mon_PROSE" },
      { description: "build log", command: "tail -F build/docs/out.log", monitorId: "mon_PATH" },
      { description: "lane reports", command: "dori report-watch 'docs'", monitorId: "mon_KEY" },
      { description: "lane screen", target: "w1:docs", monitorId: "mon_PANE" },
    ]),
  ]);
  // Then only the token and pane watches are offered, each with the field that matched.
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([
    ["mon_KEY", ["docs:command:key"]],
    ["mon_PANE", ["docs:target:pane"]],
  ]);
});

test("a done journal qualifies a lane for cleanup on its own; halted does not", () => {
  // Given two working lanes whose journals say done and halted.
  const lanes = [
    { ...lane("done-report"), reportState: "done" as const },
    { ...lane("halted-report"), reportState: "halted" as const },
  ];
  // When cleanup candidates are computed.
  const cleanup = monitorCleanup(lanes, [
    manifest([
      { command: "dori watch done-report", monitorId: "mon_DONE" },
      { command: "dori watch halted-report", monitorId: "mon_HALTED" },
    ]),
  ]);
  // Then only the done lane's watch is listed.
  expect(cleanup.map((m) => m.monitorId)).toEqual(["mon_DONE"]);
});

test("metadata discovery reads only terminal JSON, never transcripts or nested state", () => {
  // Given a session directory with a transcript, nested state and one manifest.
  const root = join(state.dir, "sessions");
  const terminal = join(root, "project", "extensions", "terminal");
  mkdirSync(join(terminal, "state"), { recursive: true });
  writeFileSync(join(root, "project", "session.jsonl"), "not JSON: never inspect");
  writeFileSync(join(terminal, "state", "private.json"), "not JSON: never inspect");
  writeFileSync(join(terminal, "owner.json"), JSON.stringify(manifest([]).data));
  // When manifests are read; then only the manifest is.
  const read = readMonitorManifests(root);
  expect(read.manifests.map((m) => m.path)).toEqual([join(terminal, "owner.json")]);
  expect(read.errors).toEqual([]);
});
