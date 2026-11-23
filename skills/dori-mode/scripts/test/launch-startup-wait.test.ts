import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchLane } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";
import type { HcTerm } from "./hc-runner.ts";

const OMO = { name: "omo", argv: ["omo"], pid: 4242 };

// How long launch waits for an agent that is slow to come up, and what still ends that wait at once (#202).

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

// omo's warning for an extension it cannot load, with the full path a real one carries, and a pane's row wrapping.
const longWarning = `Warning: Failed to load extension "/Users/someone/.omo/agent/extensions/memory-sync/index.js": Failed to load extension: Cannot find module '/Users/someone/.omo/agent/extensions/memory-sync/node_modules/gone/dist/index.mjs'`;
// Rows as hc prints them: cut every `width` characters, trailing blanks dropped (so a wrap on a space loses it).
const wrap = (text: string, width: number): string =>
  (text.match(new RegExp(`.{1,${width}}`, "g")) ?? []).map((row) => row.trimEnd()).join("\n");

// A status that stands for a runtime that cannot list its sessions.
const LOOKUP_ERROR = "(lookup error)";

let state: ReturnType<typeof withState>;

let world: World;

beforeEach(() => {
  state = withState();
  world = newWorld();
});

afterEach(() => state.done());

test("an agent that has not reported is waited for until startupWaitSeconds; a lookup error, a shell or a failure ends the wait at once", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  let waits = 0;
  // herdr lists an agent that has not reported as "unknown", and a pane with no agent (undefined here) as a shell.
  const run = async (
    status: (string | undefined)[],
    screen: string | string[],
    key: string,
    patch: { startupWaitSeconds?: number; goalMarker?: string } = {},
  ) => {
    const statuses = [...status];
    world = newWorld();
    if (Array.isArray(screen)) world.screens = [...screen];
    else world.screen = screen;
    waits = 0;
    const base = depsFor(world, { ...fakeClock(T0), sleep: async () => void waits++ }, state.dir, patch);
    const deps = {
      ...base,
      run: async (argv: readonly string[]) => {
        if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")
          return {
            code: 0,
            out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }),
            err: "",
          };
        if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list") {
          const s = statuses.length > 1 ? statuses.shift() : statuses[0];
          if (s === LOOKUP_ERROR) return { code: 1, out: "", err: "herdr is not running" };
          const agent = s ? { agent: "pi", agent_status: s } : {};
          return {
            code: 0,
            out: JSON.stringify({ result: { panes: [{ pane_id: "w:p9", workspace_id: "w", ...agent }] } }),
            err: "",
          };
        }
        return base.run(argv);
      },
    };
    return (await launchLane(deps, { key, title: "t", brief, done: "closed acme/app#3" })).startup;
  };
  const goal = "❯ \n Pursuing goal (1m)";
  // A slow host: the agent has not reported at the first check, then it comes up and sets its goal.
  expect(
    await run(["unknown", "unknown", "unknown", "idle"], ["PS> & omo", "PS> & omo", "PS> & omo", goal], "slow"),
  ).toBe("STARTUP_OK slow w:p9");
  // Every startup read asks herdr for the unwrapped screen, so a wrapped warning stays one line (#202).
  const reads = world.calls.filter((c) => c[0] === "herdr" && c[1] === "pane" && c[2] === "read");
  expect(reads.length).toBe(4);
  expect(reads.every((c) => c.at(-1) === "recent-unwrapped")).toBe(true);
  // An agent that never comes up is unconfirmed after the whole wait (20 s, then sixteen 10 s re-reads), never OK.
  expect(await run(["unknown"], "PS> & omo", "never")).toStartWith(
    "STARTUP_UNCONFIRMED never w:p9: no ready agent status (unknown) after",
  );
  expect(waits).toBe(17);
  // An agent that has not reported is never OK, even when its goal already shows, with or without a goal marker.
  expect(await run(["unknown"], goal, "goal-unreported")).toStartWith(
    "STARTUP_UNCONFIRMED goal-unreported w:p9: no ready agent status (unknown)",
  );
  expect(await run(["unknown"], goal, "goal-unreported-nomarker", { goalMarker: "" })).toStartWith(
    "STARTUP_UNCONFIRMED goal-unreported-nomarker w:p9: no ready agent status (unknown)",
  );
  // The wait is config: a 60 s host gives up after the first check and four re-reads.
  expect(await run(["unknown"], "PS> & omo", "short", { startupWaitSeconds: 60 })).toStartWith(
    "STARTUP_UNCONFIRMED short w:p9",
  );
  expect(waits).toBe(5);
  // A lookup error or a shell ends it at once, at the first check or during the wait.
  expect(await run([LOOKUP_ERROR], "PS> & omo", "err-first")).toStartWith(
    "STARTUP_UNCONFIRMED err-first w:p9: status lookup failed",
  );
  expect(waits).toBe(1);
  expect(await run(["unknown", LOOKUP_ERROR], "PS> & omo", "err-later")).toStartWith(
    "STARTUP_UNCONFIRMED err-later w:p9: status lookup failed",
  );
  expect(waits).toBe(2);
  expect(await run([undefined], "$ ", "shell-first")).toStartWith(
    "STARTUP_UNCONFIRMED shell-first w:p9: no ready agent status (shell)",
  );
  expect(waits).toBe(1);
  expect(await run(["unknown", undefined], "$ ", "shell-later")).toStartWith(
    "STARTUP_UNCONFIRMED shell-later w:p9: agent status became shell",
  );
  expect(waits).toBe(2);
  // A failure that shows while the agent has not reported ends the wait too.
  expect(await run(["unknown"], ["PS> & omo", "No API key found\n$ "], "fail-later")).toBe(
    "STARTUP_ERROR fail-later w:p9: No API key",
  );
  expect(waits).toBe(2);
});

test("on hc, a program that has not reported a status yet is waited for, and one that never does is unconfirmed", async () => {
  // Given hc, whose list shows no status until the program reports one (what a slow omo start looks like, #202).
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  let waits = 0;
  const launch = async (key: string, after: Partial<HcTerm>) => {
    world = newWorld();
    waits = 0;
    const base = depsFor(world, { ...fakeClock(T0), sleep: async () => void waits++ }, state.dir, { runtime: "hc" });
    // Typing the agent command changes the new terminal to `after` (the agent in front, its status and screen).
    const run = async (argv: readonly string[]) => {
      const ran = await base.run(argv);
      const term = argv[2] === "send" ? world.terminals[argv[3] ?? ""] : undefined;
      if (term) Object.assign(term, after);
      return ran;
    };
    return (await launchLane({ ...base, run }, { key, title: "t", brief, done: "closed acme/app#3" })).startup;
  };
  // When the launch runs and the program never reports.
  // Then it waited the whole time and says so, rather than giving up at the first check or calling it a start.
  expect(await launch("hc-never", { foreground: OMO })).toStartWith(
    "STARTUP_UNCONFIRMED hc-never t1: no ready agent status (none) after",
  );
  expect(waits).toBe(17);
  // A program that exits back to the shell is no slow start: hc lists it with no status too, but the probe names the
  // shell in front, so the launch ends at the first check instead of waiting out startupWaitSeconds.
  expect(await launch("hc-shell", { foreground: { name: "zsh", argv: ["zsh"], pid: 950 } })).toStartWith(
    "STARTUP_UNCONFIRMED hc-shell t1: no ready agent status (shell)",
  );
  expect(waits).toBe(1);
  // The extension warning wraps in a pane narrower than the line; read unwrapped, it is still only the warning (#202).
  // 95, 105 and 110 wrap on a space, which hc cuts, so a wrapped row is one cell short of the width.
  for (const cols of [80, 95, 100, 105, 110]) {
    const wrapped = wrap(longWarning, cols);
    expect(wrapped.split("\n").slice(1).join("\n")).toContain("Cannot find module");
    if (cols !== 80 && cols !== 100) expect(wrapped.split("\n").some((row) => row.length === cols - 1)).toBe(true);
    const ready = { foreground: OMO, status: { state: "idle", app: "omo" }, cols };
    expect(await launch(`hc-wrap-${cols}`, { ...ready, screen: `${wrapped}\n❯ \n Pursuing goal (1m)` })).toBe(
      `STARTUP_OK hc-wrap-${cols} t1`,
    );
    // A missing module on its own line below the wrapped warning is still a failed start.
    const failed = `${wrapped}\nError: Cannot find module '/repo/dist/cli.js'\n$ `;
    expect(await launch(`hc-wrap-err-${cols}`, { ...ready, screen: failed })).toBe(
      `STARTUP_ERROR hc-wrap-err-${cols} t1: Cannot find module`,
    );
  }
  // A warning whose last row fills the pane is joined to the next printed line; the real failure on it still counts.
  const exact = `Warning: Failed to load extension "x.js": Cannot find module '${"a".repeat(17)}'`;
  expect(exact.length).toBe(80);
  const joined = `${exact}\nError: Cannot find module '/repo/dist/cli.js'\n$ `;
  const atWidth = { foreground: OMO, status: { state: "idle", app: "omo" }, cols: 80 };
  expect(await launch("hc-exact", { ...atWidth, screen: joined })).toBe(
    "STARTUP_ERROR hc-exact t1: Cannot find module",
  );
  // Bun goes on past the module path with the extension's own path; a directory named quota-meter is no failure.
  for (const [i, tail] of [
    " imported from /Users/someone/.omo/agent/extensions/quota-meter/index.js",
    " from '/Users/someone/.omo/agent/extensions/quota-meter/index.js'",
  ].entries()) {
    const quota = wrap(`${longWarning}${tail}`, 80);
    expect(await launch(`hc-quota-${i}`, { ...atWidth, screen: `${quota}\n❯ \n Pursuing goal (1m)` })).toBe(
      `STARTUP_OK hc-quota-${i} t1`,
    );
  }
  // A failure whose words a wrap split on a space (hc cuts the space, so the joined line reads "ratelimit") still counts.
  const limited = wrap("Error from provider: rate limit reached, retry later", 26);
  expect(limited.split("\n")[0]).toBe("Error from provider: rate");
  expect(await launch("hc-split", { ...atWidth, cols: 26, screen: `${limited}\n$ ` })).toBe(
    "STARTUP_ERROR hc-split t1: rate limit reached",
  );
  // A failure glued onto the end of the extension path by a join still counts, after either tail form.
  const glued = `${exact} imported from /x/extensions/quota-meter/index.jsNo API key found\n$ `;
  expect(await launch("hc-glued", { ...atWidth, screen: glued })).toBe("STARTUP_ERROR hc-glued t1: No API key");
  // A printed line exactly as wide as the pane is joined to the next one; a failure glued on after a letter still counts.
  const filled = "Loading providers ok\nNo API key found\n$ ";
  expect(await launch("hc-filled", { ...atWidth, cols: 20, screen: filled })).toBe(
    "STARTUP_ERROR hc-filled t1: No API key",
  );
  // The everyday-word phrases glued onto a pane-wide line still count, as a provider prints them.
  for (const [i, line] of ["Rate limit exceeded", "Quota exceeded for model", "Usage limit reached"].entries()) {
    const glued = `Loading providers ok\n${line}\n$ `;
    expect(await launch(`hc-glue-${i}`, { ...atWidth, cols: 20, screen: glued })).toStartWith(
      `STARTUP_ERROR hc-glue-${i} t1: `,
    );
  }
});
