import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  dori,
  fixture,
  hc,
  hcBin,
  newHome,
  screen,
  startCore,
  statusOf,
  stopCore,
  terminal,
  until,
  waitStatus,
} from "./e2e-hc-setup.ts";

// Real hc (herdr-core), one isolated core, a fixture agent that reports OSC 7501 instead of a model: proves the hc
// runtime end to end. One lane home is shared by the lane scenarios, which run in file order.
const laneHome = newHome("lanes");
let lane = "";

const addressOf = (line: string, key: string): string => {
  const ref = new RegExp(`${key} pane=(\\S+)`).exec(line)?.[1];
  if (ref === undefined) throw new Error(`no hc ref in: ${line}`);
  return ref;
};
const rows = (r: Record<string, unknown>) => (r["terminals"] ?? []) as Record<string, unknown>[];

beforeAll(async () => {
  if (hcBin) await startCore();
});

afterAll(async () => {
  if (!hcBin) return;
  const stopped = await stopCore();
  expect(stopped.pid).toBeNumber();
  expect(stopped.alive).toBe(false);
  expect(stopped.socket).toBe(false);
});

test.skipIf(!hcBin)(
  "dori up opens lead, duty and both loops as four hc terminals labelled with one group",
  async () => {
    const home = newHome("up");
    const up = await dori(home, "up", "--cwd", home);
    expect(up).toContain("UP runtime=hc");
    const status = await dori(home, "status");
    expect(status).toContain("RUNTIME hc (from env)");
    const lead = /lead=(\S+)/.exec(status)?.[1];
    expect(lead).toBeDefined();
    const group = ((await terminal(lead ?? ""))["labels"] as Record<string, string>)["dori.group"];
    expect(group).toBeString();
    const terminals = rows(await hc("ls", "--label", `dori.group=${group}`));
    expect(terminals).toHaveLength(4);
    const labels = await Promise.all(terminals.map(async (t) => (await terminal(String(t["address"])))["labels"]));
    const roles = labels.map((l) => (l as Record<string, string>)["dori.role"]).sort();
    expect(roles).toEqual(["duty", "duty-loop", "hourly-loop", "lead"]);
    await waitStatus(lead ?? "", "idle");
  },
  60_000,
);

test.skipIf(!hcBin)(
  "dori start opens a lane whose probe is idle once the fixture reports",
  async () => {
    const brief = join(laneHome, "brief.md");
    writeFileSync(brief, "E2E-HC-BRIEF\n");
    const started = await dori(laneHome, "start", "e2e-k", "--brief", brief, "--cwd", laneHome);
    lane = addressOf(started, "STARTED e2e-k");
    // hc updates `foreground` after the first OSC 7501 report: until it shows the fixture, the login shell is in
    // front and Dori holds deliveries (#66), so the lane is ready only when both agree.
    const t = await until("the lane to report idle with the fixture in front", async () => {
      const got = await terminal(lane);
      const fg = (got["foreground"] as { argv?: string[] } | undefined)?.argv ?? [];
      return got["reported"] === true && statusOf(got) === "idle" && fg.includes(fixture) ? got : undefined;
    });
    expect((t["status"] as Record<string, unknown>)["app"]).toBe("fake");
    expect((t["labels"] as Record<string, string>)["dori.lane"]).toBe("e2e-k");
    expect(await screen(lane)).toContain("kickoff: Read your brief at");
    expect(await dori(laneHome, "status")).toMatch(new RegExp(`e2e-k\\s+working\\s+hc\\s+${lane}`));
  },
  60_000,
);

test.skipIf(!hcBin)(
  "dori send delivers to the idle lane and the fixture echoes it",
  async () => {
    expect(await dori(laneHome, "send", "e2e-k", "--text", "hi")).toContain("DELIVERED e2e-k");
    await until("the echo of hi", async () => ((await screen(lane)).includes("echo: hi") ? true : undefined));
    await waitStatus(lane, "idle");
  },
  60_000,
);

test.skipIf(!hcBin)(
  "a terminal that never reports is not an agent: send queues and nothing is typed into it",
  async () => {
    const plain = String(
      (await hc("run", "--bg", "--no-parent", "--no-notify", "--name", "plain", "--", "sh"))["address"],
    );
    const t = await until("the plain shell in front", async () => {
      const got = await terminal(plain);
      return got["foreground"] ? got : undefined;
    });
    expect(t["reported"]).toBe(false);
    expect(t["status"]).toBeNull();
    expect(await dori(laneHome, "send", `hc:${plain}`, "--text", "QUEUED-E2E")).toContain(`QUEUED hc:${plain}`);
    const inbox = join(laneHome, "inbox");
    const files = readdirSync(inbox).filter((f) => f.endsWith(".jsonl") && f.includes(plain));
    expect(files).toHaveLength(1);
    const entries = readFileSync(join(inbox, files[0] ?? ""), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("QUEUED-E2E");
    expect(await dori(laneHome, "inbox", "list", `hc:${plain}`)).toMatch(/^1 queued from cli /m);
    expect(await screen(plain)).not.toContain("QUEUED-E2E");
  },
  60_000,
);

test.skipIf(!hcBin)(
  "dori ready then done kills and removes the lane's terminal",
  async () => {
    const evidence = `file://${join(laneHome, "brief.md")}`;
    expect(await dori(laneHome, "ready", "e2e-k", "--text", "e2e-hc finished", "--evidence", evidence)).toContain(
      "READY e2e-k",
    );
    expect(await dori(laneHome, "done", "e2e-k")).toContain("DONE e2e-k");
    const all = rows(await hc("ls", "--all"));
    const left = all.find((t) => t["address"] === lane);
    expect(left === undefined || left["state"] === "finished").toBe(true);
    expect(await dori(laneHome, "status")).toMatch(/e2e-k\s+done\s+hc/);
  },
  60_000,
);
