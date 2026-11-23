/** dori launch, adopt, claim-done, object-done, close, pause and resume. */
import { type Command, die } from "./cli-context.ts";
import { claimDone, closeLane, objectDone } from "./done-flow.ts";
import { adoptLane } from "./launch-adopt.ts";
import { type LaunchInput, launchLane, prepareLaunch } from "./launch.ts";
import { pauseLane, resumeLane } from "./pause.ts";

const launch: Command = async ({ key, opt, need, ceiling, strings, values, deps }) => {
  const wallMinutes = ceiling("wall-minutes"),
    tokens = ceiling("token-limit"),
    costUsd = ceiling("cost-limit");
  const thread = opt("thread"),
    model = opt("model"),
    cwd = opt("cwd");
  const input: LaunchInput = {
    key: key ?? "",
    title: need("title"),
    brief: need("brief"),
    done: need("done"),
    ...(thread !== undefined ? { thread } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    budget: {
      ...(wallMinutes !== undefined ? { wallMinutes } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    },
    activityPaths: strings("activity-path"),
  };
  if (values["dry-run"]) {
    const prepared = await prepareLaunch(deps, input);
    for (const warning of prepared.warnings) console.error(warning);
    console.log(prepared.preamble);
    return;
  }
  const r = await launchLane(deps, input);
  for (const warning of r.warnings) console.error(warning);
  console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
  console.log(r.startup);
  process.exit(r.startup.startsWith("STARTUP_OK") || r.startup.startsWith("STARTUP_DONE") ? 0 : 3);
};

const adopt: Command = async ({ key, opt, need, deps }) => {
  const thread = opt("thread");
  const l = await adoptLane(deps, {
    key: key ?? "",
    title: need("title"),
    brief: need("brief"),
    done: need("done"),
    ...(thread !== undefined ? { thread } : {}),
    pane: need("pane"),
  });
  console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}`);
};

const close: Command = async ({ key, opt, lane, deps }) => {
  const target = await lane(key ?? die("close needs a lane key"));
  const rule = opt("lesson");
  const r = await closeLane(
    deps,
    target,
    opt("note") ?? "closed by the lead",
    rule === undefined ? undefined : { rule, evidence: opt("evidence") ?? target.done },
  );
  for (const line of r.lines) console.log(line);
  process.exit(r.closed ? 0 : 2);
};

const pauseOrResume: Command = async ({ command, key, opt, lane, deps }) => {
  const act = command === "pause" ? pauseLane : resumeLane;
  const r = await act(
    deps,
    await lane(key ?? die(`${command} needs a lane key`)),
    opt("note") ?? `${command}d by the lead`,
  );
  for (const line of r.lines) console.log(line);
  process.exit(r.code);
};

export const laneCommands: Readonly<Record<string, Command>> = {
  launch,
  adopt,
  "claim-done": async ({ key, need, lane, deps }) => {
    console.log(await claimDone(deps, await lane(key), need("evidence")));
  },
  "object-done": async ({ key, values, lane, deps }) => {
    const reasons = (values["reason"] as string[] | undefined)?.map((r) => r.trim()).filter(Boolean) ?? [];
    if (!reasons.length) die("--reason is required");
    console.log(await objectDone(deps, await lane(key ?? die("object-done needs a lane key")), reasons));
  },
  close,
  pause: pauseOrResume,
  resume: pauseOrResume,
};
