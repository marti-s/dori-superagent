import { configPath, fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { laneGoalActive } from "./goal-record.ts";
import { BRIEF_START, footer, originalBrief, quoteForPane } from "./launch-footer.ts";
import type { Runtimes } from "../../../../src/runtime/registry.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { LANE_KEY, type Lane, RESERVED_LANE_KEY, sessionFields } from "./registry.ts";
import { iso, runtimesOf } from "./run.ts";
import { Reports } from "./reports.ts";
import { doneSyntaxErrors } from "./signals.ts";
import type { BudgetLimits } from "./supervision-observe.ts";
import { Lessons, renderLessons } from "./lessons.ts";
import { laneLaunchEnv, TokenFileError } from "./slack-token.ts";
import { startupFailure } from "./startup-screen.ts";
import { launchFinished, launchScreen } from "./launch-finished.ts";
import { isKind } from "../../../../src/runtime/hc/exec.ts";

export type LaunchInput = {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly budget?: BudgetLimits;
  readonly activityPaths?: readonly string[];
};

export class LaunchError extends Error {}

// The first check is 20 s after start, then the screen and status are re-read every 10 s until `startupWaitSeconds`.
const FIRST_CHECK_MS = 20_000;
const RECHECK_MS = 10_000;
/**
 * The runtime's own status word for the lane's session. Unlike agentStatus it keeps `shell` (no agent in the session)
 * apart from no status yet: herdr lists an agent that has not reported as `unknown` and a pane with no agent as `shell`.
 * hc lists both with no status, so a session listed with none is probed, which names a shell in front. A session missing
 * from the list is `gone`.
 */
const launchStatus = async (rts: Runtimes, ref: SessionRef): Promise<{ status?: string; error?: string }> => {
  try {
    const found = (await rts.for(ref).list()).find((s) => s.ref.id === ref.id);
    if (!found) return { status: "gone" };
    if (found.status !== undefined) return { status: found.status };
    const probed = (await rts.for(ref).probe(ref)).status;
    return probed === "shell" || probed === "gone" ? { status: probed } : {};
  } catch (e) {
    if (isKind(e, "not_found")) return { status: "gone" };
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
const ready = (s: string | undefined): boolean => s === "idle" || s === "working";
const unreported = (s: string | undefined): boolean => s === undefined || s === "unknown";
// `goalMarker` is the agent's status text while a goal is active (omo: `Pursuing goal`). A lane that starts but never
// sets its goal stops after its first turn, so a ready status alone is not a good start. The status line shares its row
// with other extensions' status text, so the marker is matched in the footer (the last lines), never in agent output
// that quotes it. An empty marker turns the check off. The footer is cut to the pane's width (a narrow pane shows
// "Pur..."), so omo's own goal record for the lane's session counts too, whatever the width (#122).
const goalShown = (screen: string, marker: string): boolean =>
  screen
    .split("\n")
    .filter((s) => s.trim())
    .slice(-3)
    .join("\n")
    .includes(marker);

export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  if (!LANE_KEY.test(input.key)) throw new LaunchError(`key must match ${LANE_KEY}`);
  if (input.key === RESERVED_LANE_KEY)
    throw new LaunchError(`lane key "${RESERVED_LANE_KEY}" is reserved for the lead`);
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} is already registered`);
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
  for (const [name, value] of Object.entries(input.budget ?? {})) {
    if (value != null && (!Number.isFinite(value) || value < 0)) throw new LaunchError(`invalid ${name} ceiling`);
  }
};

export const prepareLaunch = async (
  deps: FlowDeps,
  input: LaunchInput,
): Promise<{ readonly lane: Lane; readonly preamble: string; readonly warnings: string[] }> => {
  await validateLaunch(deps, input);
  const model = input.model ?? deps.config.defaultModel;
  const cwd = input.cwd ?? deps.config.defaultCwd;
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  const draft: Lane = {
    key: input.key,
    title: input.title,
    thread: input.thread ?? "none",
    brief: input.brief,
    done: input.done,
    cwd,
    model,
    openedAt: iso(deps.clock),
    reportProtocol: "jsonl-v1",
    budget: {
      ...deps.config.supervision.defaults,
      ...deps.config.supervision.lanes?.[input.key],
      // An undefined field is absent, so it keeps the configured ceiling; only null turns one off.
      ...Object.fromEntries(Object.entries(input.budget ?? {}).filter(([, value]) => value !== undefined)),
    },
    activityPaths: input.activityPaths ?? [],
  };
  // A damaged journal line is a warning: it must not keep a lane from starting or hide the lessons around it.
  const { lessons, problems } = new Lessons(deps.config.stateDir).forRepo(cwd);
  return {
    lane: draft,
    warnings: problems.map((problem) => `LESSON_WARNING ${problem}`),
    preamble: `${renderLessons(lessons)}${BRIEF_START}\n${originalBrief(await briefFile.text())}\n${footer(draft, deps.config.leadPane, deps.config.repoIdentities)}`,
  };
};

export const launchLane = async (
  deps: FlowDeps,
  input: LaunchInput,
): Promise<{ readonly lane: Lane; readonly startup: string; readonly warnings: string[] }> => {
  const prepared = await prepareLaunch(deps, input);
  return { ...(await startLane(deps, input, prepared.lane, prepared.preamble)), warnings: prepared.warnings };
};

const startLane = async (
  deps: FlowDeps,
  input: LaunchInput,
  draft: Lane,
  preamble: string,
): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  const model = input.model ?? deps.config.defaultModel;
  const cwd = input.cwd ?? deps.config.defaultCwd;
  await Bun.write(input.brief, preamble);
  const rts = runtimesOf(deps);
  const group = deps.config.laneWorkspace || undefined;
  let env: Record<string, string>;
  try {
    env = laneLaunchEnv(process.env, configPath());
  } catch (e) {
    throw e instanceof TokenFileError ? new LaunchError(`token file refused: ${e.message}`) : e;
  }
  let ref: SessionRef;
  try {
    const spec = { name: input.key, role: "lane", container: "tab", cwd, env } as const;
    ref = await rts.default.create(group === undefined ? spec : { ...spec, group });
  } catch (e) {
    throw new LaunchError(`session create failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const pane = ref.id;
  // Registered before the agent starts: dori report refuses an unknown key, so a fast lane's first report would be lost.
  const lane: Lane = { ...draft, ...sessionFields(ref) };
  await deps.registry.write(lane);
  // The launch is an activity record, not a report: it starts the journal (so the screen is watched for a stall) but is
  // never posted to the thread as if the agent had reported.
  new Reports(deps.config.stateDir).append({
    type: "activity",
    key: lane.key,
    at: iso(deps.clock),
    state: "running",
    text: `lane launched in ${pane}`,
  });
  const prompt = `${deps.config.launchKeywords}. Read and execute the lane brief at ${input.brief} in full. You are the ${input.key} lane; report as the brief's footer says.`;
  try {
    await rts.for(ref).start(ref, fill(deps.config.agentCommand, { model, prompt }).map(quoteForPane).join(" "));
  } catch (e) {
    return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}: start failed: ${lastLines(String(e))}` };
  }
  const started = deps.clock.now();
  await deps.clock.sleep(FIRST_CHECK_MS);
  const screen = await launchScreen(deps, rts, ref, input.key);
  if (screen === null) return { lane, startup: `STARTUP_DONE ${input.key}` };
  const bad = startupFailure(screen);
  if (bad) return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}: ${bad}` };
  const { status, error } = await launchStatus(rts, ref);
  if (status === "gone" && (await launchFinished(deps, input.key)))
    return { lane, startup: `STARTUP_DONE ${input.key}` };
  // No status and no lookup error is an agent still starting (a slow host can take minutes, #202): it is waited for in
  // the goal wait. A lookup error, a `shell` or any other status ends the launch below at once.
  if (ready(status) || (unreported(status) && !error)) {
    const marker = deps.config.goalMarker;
    const hasGoal = (shown: string): boolean =>
      goalShown(shown, marker) || laneGoalActive(deps.config.sessionsDir, cwd, input.key, started);
    const rechecks = Math.max(0, Math.ceil((deps.config.startupWaitSeconds * 1000 - FIRST_CHECK_MS) / RECHECK_MS));
    let shown = screen;
    let current = status;
    for (let check = 0; !ready(current) || (marker && !hasGoal(shown)); check++) {
      if (check >= rechecks) {
        const waited = Math.round((deps.clock.now() - started) / 1000);
        return {
          lane,
          startup: ready(current)
            ? `STARTUP_NO_GOAL ${input.key} ${pane}: the agent is running but shows no goal after ${waited} s; last lines: ${lastLines(shown)}`
            : `STARTUP_UNCONFIRMED ${input.key} ${pane}: no ready agent status (${current ?? "none"}) after ${waited} s; last lines: ${lastLines(shown)}`,
        };
      }
      await deps.clock.sleep(RECHECK_MS);
      const nextScreen = await launchScreen(deps, rts, ref, input.key);
      if (nextScreen === null) return { lane, startup: `STARTUP_DONE ${input.key}` };
      shown = nextScreen;
      // The goal is only good news while the agent is still running: re-check the status on every re-read.
      const again = await launchStatus(rts, ref);
      current = again.status;
      if (current === "gone" && (await launchFinished(deps, input.key)))
        return { lane, startup: `STARTUP_DONE ${input.key}` };
      if (again.error || !(ready(current) || unreported(current))) {
        const lost = again.error
          ? `status lookup failed: ${again.error}`
          : `agent status became ${again.status ?? "none"}`;
        return {
          lane,
          startup: `STARTUP_UNCONFIRMED ${input.key} ${pane}: ${lost} while waiting for its goal; last lines: ${lastLines(shown)}`,
        };
      }
      // A late failure stops the agent. A working agent's own output may quote these phrases (a file or log it reads),
      // so only an idle agent with no goal is checked for one.
      const failed = current !== "working" && !hasGoal(shown) ? startupFailure(shown) : null;
      if (failed) return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}: ${failed}` };
    }
    return { lane, startup: `STARTUP_OK ${input.key} ${pane}` };
  }
  const why = error ? `status lookup failed: ${error}` : `no ready agent status (${status ?? "none"})`;
  return { lane, startup: `STARTUP_UNCONFIRMED ${input.key} ${pane}: ${why}; last lines: ${lastLines(screen)}` };
};

const lastLines = (screen: string): string =>
  screen
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" / ")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .slice(0, 240) || "(blank)";
