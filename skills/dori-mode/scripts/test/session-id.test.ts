import { expect, test } from "bun:test";

import { runtimesFor } from "../src/run.ts";
import { resolveSession } from "../src/session-id.ts";
import { hcAnswer, hcTerm } from "./hc-runner.ts";

const P1 = { runtime: "hc", id: "t1" } as const;

test("the session id is read from --session, then a child's environment, then the session file made at start", async () => {
  const info = JSON.stringify({
    address: "t1",
    state: "live",
    pid: 10,
    foreground: { name: "zsh", argv: ["zsh"], pid: 10 },
  });
  const fake = (extra: Record<string, string>) => async (argv: readonly string[]) => {
    const line = argv.join(" ");
    if (line.startsWith("hc --json get t1")) return { code: 0, out: info, err: "" };
    const hit = Object.entries(extra).find(([k]) => line.startsWith(k));
    return { code: hit ? 0 : 1, out: hit?.[1] ?? "", err: "" };
  };
  const table = [
    { pid: 10, ppid: 1, cmd: "zsh" },
    { pid: 11, ppid: 10, cmd: "/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin" },
    { pid: 12, ppid: 11, cmd: "bun /x/mcp/cli.js mcp" },
  ];
  const flagged = [
    { pid: 10, ppid: 1, cmd: "zsh" },
    { pid: 11, ppid: 10, cmd: "omo --session 01a0e129-23ce-7329-bbd1-fc0c1e7a6b8b" },
  ];
  expect((await resolveSession(P1, "/repo", flagged, { run: fake({}), sessionsDir: "/s" })).via).toBe("argv");
  expect(
    (
      await resolveSession(P1, "/repo", table, {
        run: fake({ "ps eww -o command= -p 12": "bun mcp PI_SESSION_ID=01a11440-ee81-7f90-b2ed-dcc7d51a0adf X=1" }),
        sessionsDir: "/s",
      })
    ).id,
  ).toBe("01a11440-ee81-7f90-b2ed-dcc7d51a0adf");
  const listDir = () => [
    "2026-01-01T09-00-00-000Z_01a10000-0000-7000-8000-000000000000.jsonl",
    "2026-01-01T12-00-02-113Z_01a11440-ee81-7f90-b2ed-dcc7d51a0adf.jsonl",
  ];
  const byStart = await resolveSession(P1, "/repo", table, {
    run: fake({ "ps eww": "bun mcp X=1", "ps -o lstart=": "Thu Jan  1 12:00:01 2026 GMT" }),
    sessionsDir: "/s",
    listDir,
  });
  expect(byStart).toEqual({ id: "01a11440-ee81-7f90-b2ed-dcc7d51a0adf", via: "start-time", pid: 11 });
});

test("an agent run directly as the session's program is the root itself", async () => {
  const world = { terminals: { t1: hcTerm({ pid: 900 }) } };
  const run = async (argv: readonly string[]) =>
    argv[0] === "hc" ? hcAnswer(world, argv) : { code: 1, out: "", err: "" };
  const table = [{ pid: 900, ppid: 1, cmd: "omo --session 01a0e129-23ce-7329-bbd1-fc0c1e7a6b8b" }];
  const rts = runtimesFor({ runtime: "hc" }, {}, run);
  const hit = await resolveSession({ runtime: "hc", id: "t1" }, "/repo", table, { run, sessionsDir: "/s", rts });
  expect(hit).toEqual({ id: "01a0e129-23ce-7329-bbd1-fc0c1e7a6b8b", via: "argv", pid: 900 });
});
