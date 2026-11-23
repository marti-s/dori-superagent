import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { laneTokenEnv, slackToken, TokenFileError, tokenFileNotice, WIN32_ACL_NOTICE } from "../src/slack-token.ts";
import { withState } from "./fakes.ts";

// Reading the Slack token file (#200): one descriptor, owner, mode, type, links. The lane env is in slack-token.test.ts.
let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

// Paths are real (macOS /var -> /private/var), and the home is the state dir, so reads pass the home check.
const base = (): string => realpathSync(state.dir);
const read = (...[env, platform, uid]: Parameters<typeof slackToken>): string | undefined =>
  slackToken(env, platform, uid, join(base(), "config.json"));

const tokenFile = (dir: string, text: string, mode: number): string => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "slack-token");
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
};

test("DORI_SLACK_TOKEN is read first, then the token file when the variable is unset or empty", () => {
  const file = tokenFile(join(base(), "t"), "  xoxb-from-file\n", 0o600);
  expect(read({ DORI_SLACK_TOKEN: "xoxb-from-env", DORI_SLACK_TOKEN_FILE: file })).toBe("xoxb-from-env");
  expect(read({ DORI_SLACK_TOKEN: "", DORI_SLACK_TOKEN_FILE: file })).toBe("xoxb-from-file");
  expect(read({ DORI_SLACK_TOKEN_FILE: file })).toBe("xoxb-from-file");
  expect(read({})).toBeUndefined();
});

test("a token file open to group or others is refused on POSIX; Windows has no mode bits to check", () => {
  const file = tokenFile(join(base(), "open"), "xoxb-open\n", 0o644);
  expect(() => read({ DORI_SLACK_TOKEN_FILE: file }, "linux")).toThrow(/is open to group or others.*chmod 600/);
  expect(read({ DORI_SLACK_TOKEN_FILE: file }, "win32")).toBe("xoxb-open");
});

test("a missing or empty token file is refused, never read as no token", () => {
  expect(() => read({ DORI_SLACK_TOKEN_FILE: join(base(), "absent") })).toThrow(TokenFileError);
  const empty = tokenFile(join(base(), "empty"), "\n", 0o600);
  expect(() => read({ DORI_SLACK_TOKEN_FILE: empty })).toThrow(/is empty/);
});

test("a link loop is named as a loop, and a link put at the resolved name after launch is not followed", () => {
  const dir = join(base(), "loop-home");
  mkdirSync(dir, { recursive: true });
  const a = join(dir, "a");
  const b = join(dir, "b");
  symlinkSync(b, a);
  symlinkSync(a, b);
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: a }, join(dir, "config.json"))).toThrow(/is a link loop/);
  // A lane gets its path resolved and marked by launch, and opens that string as-is with O_NOFOLLOW: a link put at that
  // exact name after launch is refused, never followed. No mock: this is the production path.
  const file = tokenFile(join(dir, "real"), "xoxb-own\n", 0o600);
  const planted = tokenFile(join(dir, "planted"), "xoxb-planted\n", 0o600);
  const lane = laneTokenEnv({ DORI_SLACK_TOKEN_FILE: file }, join(dir, "config.json"));
  const inLane = () => slackToken(lane, "linux", process.getuid?.(), join(dir, "config.json"));
  expect(inLane()).toBe("xoxb-own");
  renameSync(file, `${file}.moved`);
  symlinkSync(planted, file);
  expect(inLane).toThrow(/cannot be read/);
});

test("a token-file link the user set up is resolved once by the reader, and that same string is checked and read", () => {
  const dir = join(base(), "user-link");
  const target = tokenFile(join(dir, "keys"), "xoxb-linked\n", 0o600);
  const link = join(dir, "my-token");
  symlinkSync(target, link);
  const config = join(dir, "config.json");
  const resolved = spyOn(fs.realpathSync, "native");
  try {
    expect(slackToken({ DORI_SLACK_TOKEN_FILE: link }, "linux", process.getuid?.(), config)).toBe("xoxb-linked");
    expect(resolved.mock.calls.filter(([p]) => String(p) === link).length).toBe(1);
  } finally {
    resolved.mockRestore();
  }
});

test("a directory or a FIFO at the path is refused as not a regular file, and a FIFO never blocks the read", () => {
  const dir = join(base(), "a-dir");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  expect(() => read({ DORI_SLACK_TOKEN_FILE: dir }, "linux")).toThrow(
    `DORI_SLACK_TOKEN_FILE ${dir} is not a regular file`,
  );
  const fifo = join(base(), "fifo");
  expect(Bun.spawnSync(["mkfifo", "-m", "600", fifo]).exitCode).toBe(0);
  expect(() => read({ DORI_SLACK_TOKEN_FILE: fifo }, "linux")).toThrow(
    `DORI_SLACK_TOKEN_FILE ${fifo} is not a regular file`,
  );
});

test("the file is checked and read through one descriptor: a file swapped in after the check is never read", () => {
  const dir = join(base(), "swap");
  const file = tokenFile(dir, "xoxb-own\n", 0o600);
  const planted = join(dir, "planted");
  writeFileSync(planted, "xoxb-planted\n");
  chmodSync(planted, 0o600);
  // The path is replaced right after the owner/mode check, the window a stat-then-read-by-path would expose.
  const realFstat = fs.fstatSync;
  const swap = spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
    const st = realFstat(fd);
    renameSync(planted, file);
    return st;
  }) as typeof fs.fstatSync);
  try {
    expect(read({ DORI_SLACK_TOKEN_FILE: file }, "linux", process.getuid?.())).toBe("xoxb-own");
    expect(swap).toHaveBeenCalledTimes(1);
  } finally {
    swap.mockRestore();
  }
});

test("a token file owned by another user is refused, even owner-only", () => {
  const file = tokenFile(join(base(), "other"), "xoxb-other\n", 0o600);
  const me = process.getuid?.() ?? 0;
  expect(() => read({ DORI_SLACK_TOKEN_FILE: file }, "linux", me + 1)).toThrow(/is owned by uid \d+, not by this user/);
  expect(read({ DORI_SLACK_TOKEN_FILE: file }, "linux", me)).toBe("xoxb-other");
});

test("on Windows a token taken from a file comes with a notice that its ACL is not checked", () => {
  expect(tokenFileNotice({ DORI_SLACK_TOKEN_FILE: "C:\\x\\slack-token" }, "win32")).toBe(WIN32_ACL_NOTICE);
  expect(tokenFileNotice({ DORI_SLACK_TOKEN_FILE: "/x/slack-token" }, "linux")).toBeUndefined();
  expect(tokenFileNotice({ DORI_SLACK_TOKEN: "xoxb-env", DORI_SLACK_TOKEN_FILE: "C:\\x" }, "win32")).toBeUndefined();
});

test("a lane env inherited into another home is not trusted there: home B refuses home A's marked token file (#200)", () => {
  const homeA = join(base(), "home-a");
  const fileA = tokenFile(homeA, "xoxb-home-A\n", 0o600);
  const laneOfA = laneTokenEnv({ DORI_SLACK_TOKEN_FILE: fileA }, join(homeA, "config.json"));
  // In home A the marked path is read as it is.
  expect(slackToken(laneOfA, "linux", process.getuid?.(), join(homeA, "config.json"))).toBe("xoxb-home-A");
  // In home B the same env is checked like any unmarked path, and A's file is outside B.
  const homeB = join(base(), "home-b");
  mkdirSync(homeB, { recursive: true });
  expect(() => slackToken(laneOfA, "linux", process.getuid?.(), join(homeB, "config.json"))).toThrow(
    /is outside this home/,
  );
});

test("a token path with '..' after a link is home-checked where the OS opens it, not where the text points", () => {
  const home = join(base(), "dd-home");
  const elsewhere = join(base(), "dd-elsewhere");
  mkdirSync(join(elsewhere, "deep"), { recursive: true });
  tokenFile(elsewhere, "xoxb-elsewhere\n", 0o600);
  tokenFile(home, "xoxb-home\n", 0o600);
  symlinkSync(join(elsewhere, "deep"), join(home, "link"));
  // On paper home/link/../slack-token is home/slack-token; the OS opens elsewhere/slack-token, outside the home.
  const raw = `${home}/link/../slack-token`;
  expect(() => laneTokenEnv({ DORI_SLACK_TOKEN_FILE: raw }, join(home, "config.json"))).toThrow(/is outside this home/);
});
