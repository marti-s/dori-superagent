import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { launchLane } from "../src/launch.ts";
import { laneTokenEnv, OUTSIDE_HOME_FLAG, RESOLVED_HOME, RESOLVED_MARK, TokenFileError } from "../src/slack-token.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

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

// The lane gets the real path (links resolved, e.g. macOS /var -> /private/var); every path here is under state.dir.
const real = (p: string): string => join(realpathSync(state.dir), relative(state.dir, p));

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

test("the create argv for a lane never contains the token value, only the token file's path (#200)", async () => {
  // Given a launcher with a token in its env and this home's owner-only token file next to its config.
  const home = join(state.dir, "home");
  const file = tokenFile(home, "xoxb-file-secret\n", 0o600);
  process.env["DORI_SLACK_TOKEN"] = "xoxb-launcher-secret";
  delete process.env["DORI_SLACK_TOKEN_FILE"];
  // When the lane is created on hc, which puts every env value on the command line.
  const calls = await launchArgv(home, "token-lane");
  // Then no argv of any call holds a token, and the lane gets the path with DORI_SLACK_TOKEN blanked.
  expect(calls.flat().filter((arg) => arg.includes("xoxb-"))).toEqual([]);
  const create = calls.find((c) => c[0] === "hc" && c.includes("run") && c.includes("--bg")) ?? [];
  expect(create).toContain(`DORI_SLACK_TOKEN_FILE=${real(file)}`);
  expect(create).toContain("DORI_SLACK_TOKEN=");
});

test("with no token file the lane env is unchanged, as in a single-home setup", async () => {
  process.env["DORI_SLACK_TOKEN"] = "xoxb-launcher-secret";
  delete process.env["DORI_SLACK_TOKEN_FILE"];
  const calls = await launchArgv(join(state.dir, "plain-home"), "plain-lane");
  expect(calls.flat().filter((arg) => arg.includes("DORI_SLACK_TOKEN") || arg.includes("xoxb-"))).toEqual([]);
});

test("a relative token-file path is passed absolute, since the lane runs in another directory", async () => {
  const home = join(state.dir, "rel-home");
  const file = tokenFile(home, "xoxb-rel\n", 0o600);
  process.env["DORI_SLACK_TOKEN_FILE"] = relative(process.cwd(), file);
  const create = (await launchArgv(home, "rel-lane")).find((c) => c[0] === "hc" && c.includes("--bg")) ?? [];
  expect(create).toContain(`DORI_SLACK_TOKEN_FILE=${real(file)}`);
});

test("the home's own slack-token is passed even when missing, so the lane never falls back to the core's token", async () => {
  const absent = join(state.dir, "named-home", "slack-token");
  process.env["DORI_SLACK_TOKEN_FILE"] = absent;
  const create =
    (await launchArgv(join(state.dir, "named-home"), "named-lane")).find((c) => c[0] === "hc" && c.includes("--bg")) ??
    [];
  expect(create).toContain(`DORI_SLACK_TOKEN_FILE=${real(absent)}`);
  expect(create).toContain("DORI_SLACK_TOKEN=");
});

test("any other named token file that does not exist yet is refused: a link later put there is what the lane would follow", () => {
  const home = join(state.dir, "absent-home");
  mkdirSync(home, { recursive: true });
  const other = join(home, "named", "slack-token");
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: other }, join(home, "config.json"))).toThrow(/does not exist/);
});

test("an inherited DORI_SLACK_TOKEN_FILE outside this home is refused unless the flag says it is meant", () => {
  const home = join(state.dir, "own-home");
  const config = join(home, "config.json");
  tokenFile(home, "xoxb-own\n", 0o600);
  const other = tokenFile(join(state.dir, "other-home"), "xoxb-other\n", 0o600);
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: other }, config)).toThrow(TokenFileError);
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: other }, config)).toThrow(/is outside this home/);
  // Allowed by the flag, and the flag is passed empty so the lane does not carry the permission onward.
  expect(laneTokenEnv({ DORI_SLACK_TOKEN_FILE: other, [OUTSIDE_HOME_FLAG]: "1" }, config)).toEqual({
    DORI_SLACK_TOKEN_FILE: real(other),
    [RESOLVED_MARK]: real(other),
    [RESOLVED_HOME]: real(home),
    DORI_SLACK_TOKEN: "",
    [OUTSIDE_HOME_FLAG]: "",
  });
  // Unset, the home's own file is used; a file inside the home is passed as named.
  const ok = (file: string) => ({
    DORI_SLACK_TOKEN_FILE: real(file),
    [RESOLVED_MARK]: real(file),
    [RESOLVED_HOME]: real(home),
    DORI_SLACK_TOKEN: "",
    [OUTSIDE_HOME_FLAG]: "",
  });
  expect(laneTokenEnv({}, config)).toEqual(ok(join(home, "slack-token")));
  const nested = tokenFile(join(home, "keys"), "xoxb-nested\n", 0o600);
  expect(laneTokenEnv({ DORI_SLACK_TOKEN_FILE: nested }, config)).toEqual(ok(nested));
  // A file whose name starts with ".." is still inside the home.
  const dotted = join(home, "..slack-token");
  writeFileSync(dotted, "xoxb-dotted\n");
  expect(laneTokenEnv({ DORI_SLACK_TOKEN_FILE: dotted }, config)).toEqual(ok(dotted));
  // A link inside the home to another home's file is outside: links are resolved before the check.
  const link = join(home, "linked-token");
  symlinkSync(other, link);
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: link }, config)).toThrow(/is outside this home/);
});

test("the home's own slack-token gets the same link check, and an inherited allow flag never reaches a lane", () => {
  const other = tokenFile(join(state.dir, "far-home"), "xoxb-far\n", 0o600);
  const linked = join(state.dir, "linked-home");
  mkdirSync(linked, { recursive: true });
  symlinkSync(other, join(linked, "slack-token"));
  expect(() => laneTokenEnv({}, join(linked, "config.json"))).toThrow(/links outside this home/);
  // With no token file at all, nothing is added except emptying an inherited allow flag.
  const bare = join(state.dir, "bare-home", "config.json");
  expect(laneTokenEnv({}, bare)).toEqual({});
  expect(laneTokenEnv({ [OUTSIDE_HOME_FLAG]: "1" }, bare)).toEqual({ [OUTSIDE_HOME_FLAG]: "" });
  // The lane gets the resolved path: a link inside the home that is later swapped to another home's file is not used.
  const homeL = join(state.dir, "relink-home");
  const target = tokenFile(join(homeL, "keys"), "xoxb-own\n", 0o600);
  symlinkSync(target, join(homeL, "slack-token"));
  const passed = laneTokenEnv({}, join(homeL, "config.json"))["DORI_SLACK_TOKEN_FILE"];
  expect(passed).toBe(realpathSync(target));
  const named = laneTokenEnv({ DORI_SLACK_TOKEN_FILE: join(homeL, "slack-token") }, join(homeL, "config.json"));
  expect(named["DORI_SLACK_TOKEN_FILE"]).toBe(realpathSync(target));
  // The path is resolved once: the string checked is the string passed, so no swap between two resolutions reaches the lane.
  const spy = spyOn(fs.realpathSync, "native");
  try {
    laneTokenEnv({ DORI_SLACK_TOKEN_FILE: join(homeL, "slack-token") }, join(homeL, "config.json"));
    expect(spy.mock.calls.filter(([p]) => String(p).endsWith(`${"relink-home"}/slack-token`)).length).toBe(1);
  } finally {
    spy.mockRestore();
  }
  // A named link whose target does not exist yet is refused: the lane would follow it wherever it later points.
  const dangling = join(homeL, "dl");
  symlinkSync(join(state.dir, "not-yet", "slack-token"), dangling);
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: dangling }, join(homeL, "config.json"))).toThrow(
    /is a link whose target does not exist/,
  );
});

test("a launch with a token file outside this home is refused before any session is created", async () => {
  const home = join(state.dir, "launch-home");
  const other = tokenFile(join(state.dir, "launch-other"), "xoxb-other\n", 0o600);
  delete process.env["DORI_SLACK_TOKEN"];
  process.env["DORI_SLACK_TOKEN_FILE"] = other;
  delete process.env[OUTSIDE_HOME_FLAG];
  await expect(launchArgv(home, "outside-lane")).rejects.toThrow(
    /^token file refused: DORI_SLACK_TOKEN_FILE .* is outside this home/,
  );
  expect(world.calls.some((c) => c[0] === "hc" && c.includes("run"))).toBe(false);
});

test("a relative DORI_CONFIG is passed to the lane absolute, so the lane finds the same home and its token-file mark holds", async () => {
  const home = join(state.dir, "rel-config-home");
  const file = tokenFile(home, "xoxb-rel\n", 0o600);
  delete process.env["DORI_SLACK_TOKEN"];
  delete process.env["DORI_SLACK_TOKEN_FILE"];
  const calls = await launchArgv(home, "relconf-lane", relative(process.cwd(), join(home, "config.json")));
  const create = calls.find((c) => c[0] === "hc" && c.includes("--bg")) ?? [];
  expect(create).toContain(`DORI_CONFIG=${process.cwd()}${sep}${relative(process.cwd(), join(home, "config.json"))}`);
  expect(create).toContain(`DORI_SLACK_TOKEN_FILE=${real(file)}`);
});

test("a DORI_CONFIG whose home moves when normalized (empty, '.', '..') is refused instead of moving the home up", async () => {
  delete process.env["DORI_SLACK_TOKEN"];
  delete process.env["DORI_SLACK_TOKEN_FILE"];
  const home = join(state.dir, "bad-config-home");
  for (const raw of ["", ".", ".."]) {
    await expect(launchArgv(home, `bad-${raw.length}`, raw)).rejects.toThrow(/does not name a config file/);
  }
});

test("an absolute DORI_CONFIG reaches the lane unchanged, so a link in it resolves for the lane as it did for the launcher", async () => {
  delete process.env["DORI_SLACK_TOKEN"];
  delete process.env["DORI_SLACK_TOKEN_FILE"];
  const home = join(state.dir, "abs-home");
  mkdirSync(home, { recursive: true });
  const raw = `${home}/sub/../config.json`;
  const create = (await launchArgv(home, "abs-lane", raw)).find((c) => c[0] === "hc" && c.includes("--bg")) ?? [];
  expect(create.some((arg) => arg.startsWith("DORI_CONFIG="))).toBe(false);
});

test("a relative DORI_CONFIG with '..' keeps it, so the OS follows a link in it for the lane as it did for the launcher", async () => {
  delete process.env["DORI_SLACK_TOKEN"];
  delete process.env["DORI_SLACK_TOKEN_FILE"];
  const home = join(state.dir, "dotdot-home");
  mkdirSync(join(home, "sub"), { recursive: true });
  const raw = `${relative(process.cwd(), join(home, "sub"))}${sep}..${sep}config.json`;
  const create = (await launchArgv(home, "dotdot-lane", raw)).find((c) => c[0] === "hc" && c.includes("--bg")) ?? [];
  // Not collapsed on paper: the '..' is still there for the OS to resolve.
  expect(create).toContain(`DORI_CONFIG=${process.cwd()}${sep}${raw}`);
});
