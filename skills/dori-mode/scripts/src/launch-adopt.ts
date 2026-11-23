import { parseRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type LaunchInput, validateLaunch } from "./launch.ts";
import { type Lane, sessionFields } from "./registry.ts";
import { iso, runtimesOf } from "./run.ts";

export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { readonly pane: string }): Promise<Lane> => {
  await validateLaunch(deps, input);
  const base: Lane = {
    key: input.key,
    title: input.title,
    thread: input.thread ?? "none",
    brief: input.brief,
    done: input.done,
    cwd: input.cwd ?? deps.config.defaultCwd,
    openedAt: iso(deps.clock),
  };
  // `hc:t7`, `herdr:w1:p3` or a bare `w1:p3` names its runtime; any other id is a session on the runtime new lanes
  // open on (as `dori boot` prints it), never the legacy herdr reading of records written before runtimes existed.
  const ref = parseRef(input.pane) ?? { runtime: runtimesOf(deps).default.kind, id: input.pane };
  const lane = { ...base, ...sessionFields(ref) };
  await deps.registry.write(lane);
  return lane;
};
