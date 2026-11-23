import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { launchLane } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

// The token home follows the config file the OS opens, through links and '..' (#218, #219).
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const KEYS = ["DORI_CONFIG", "DORI_SLACK_TOKEN", "DORI_SLACK_TOKEN_FILE"] as const;
let state: ReturnType<typeof withState>;
let world: World;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  state = withState();
  world = newWorld();
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  state.done();
});

const tokenFile = (dir: string, text: string, mode: number): string => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "slack-token");
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
};

const launchArgv = async (home: string, key: string, config = join(home, "config.json")): Promise<string[][]> => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  process.env["DORI_CONFIG"] = config;
  world = newWorld();
  await launchLane(depsFor(world, fakeClock(T0), join(home, "state"), { runtime: "hc" }), {
    key,
    title: "t",
    brief,
    done: "closed acme/app#3",
  });
  return world.calls.map((c) => [...c]);
};

test("with a real link, 'link/../config.json' opens far's config, and far is the token home for launcher and lane alike", async () => {
  delete process.env["DORI_SLACK_TOKEN"];
  delete process.env["DORI_SLACK_TOKEN_FILE"];
  const near = join(state.dir, "near");
  const far = join(state.dir, "far");
  mkdirSync(join(far, "a"), { recursive: true });
  writeFileSync(join(far, "config.json"), "{}");
  const farToken = tokenFile(far, "xoxb-far\n", 0o600);
  tokenFile(near, "xoxb-near\n", 0o600);
  symlinkSync(join(far, "a"), join(near, "link"));
  const raw = `${relative(process.cwd(), near)}${sep}link${sep}..${sep}config.json`;
  const create = (await launchArgv(near, "link-lane", raw)).find((c) => c[0] === "hc" && c.includes("--bg")) ?? [];
  expect(create).toContain(`DORI_SLACK_TOKEN_FILE=${realpathSync(farToken)}`);
  expect(create).toContain(`DORI_CONFIG=${process.cwd()}${sep}${raw}`);
});

test("a config file that does not exist yet still gets its home where the OS would create it, through the link", async () => {
  delete process.env["DORI_SLACK_TOKEN"];
  delete process.env["DORI_SLACK_TOKEN_FILE"];
  const near = join(state.dir, "near2");
  const far = join(state.dir, "far2");
  mkdirSync(join(far, "a"), { recursive: true });
  const farToken = tokenFile(far, "xoxb-far2\n", 0o600);
  tokenFile(near, "xoxb-near2\n", 0o600);
  symlinkSync(join(far, "a"), join(near, "link"));
  const raw = `${relative(process.cwd(), near)}${sep}link${sep}..${sep}config.json`;
  const create = (await launchArgv(near, "nolink-lane", raw)).find((c) => c[0] === "hc" && c.includes("--bg")) ?? [];
  expect(create).toContain(`DORI_SLACK_TOKEN_FILE=${realpathSync(farToken)}`);
});
