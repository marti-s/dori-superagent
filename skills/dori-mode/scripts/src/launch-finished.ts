import type { Runtimes } from "../../../../src/runtime/registry.ts";
import { isKind } from "../../../../src/runtime/hc/exec.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { finished } from "./boot-monitors.ts";
import type { FlowDeps } from "./done-flow.ts";
import { Reports } from "./reports.ts";
import { startupScreen } from "./startup-screen.ts";

export const launchFinished = async (deps: FlowDeps, key: string): Promise<boolean> => {
  const lane = await deps.registry.read(key);
  return lane !== null && finished({ ...lane, reportState: new Reports(deps.config.stateDir).read(key)?.state });
};

export const launchScreen = async (
  deps: FlowDeps,
  rts: Runtimes,
  ref: SessionRef,
  key: string,
): Promise<string | null> => {
  try {
    return await startupScreen(rts, ref);
  } catch (error) {
    if (isKind(error, "not_found") && (await launchFinished(deps, key))) return null;
    throw error;
  }
};
