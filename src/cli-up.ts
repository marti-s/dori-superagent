import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "./delivery.ts";
import { promptsDir, type Deps } from "./harness.ts";
import { refText } from "./refs.ts";
import { groupId } from "./runtime/group.ts";
import { openSession, type SessionRef } from "./runtime/types.ts";
import { RuntimeChoiceError } from "./runtime/select.ts";

function renderPrompt(d: Deps, name: string): string {
  const dir = join(d.store.root, "prompts");
  mkdirSync(dir, { recursive: true });
  const src = readFileSync(join(promptsDir(), name), "utf8").replaceAll("{{dori}}", d.doriCmd);
  const out = join(dir, name);
  writeFileSync(out, src);
  return out;
}

/** Opens lead, duty, the duty loop and the hourly loop as four hc terminals labelled with this home's group, and registers all four roles. */
export async function up(d: Deps, cwd: string): Promise<void> {
  const rt = d.runtimes.default;
  const env = { DORI_HOME: d.store.root };
  const agent = (name: string) => `${d.agentCmd} --append-system-prompt ${shq(renderPrompt(d, name))}`;
  const group = groupId(d.store.root);
  const lead = await openSession(rt, { name: "dori", role: "lead", cwd, env: {}, group }, agent("lead.md"));
  d.store.setRole("lead", lead);
  const duty = await openSession(rt, { name: "duty", role: "duty", cwd, env, group }, agent("duty.md"));
  d.store.setRole("duty", duty);
  const loop = await openSession(
    rt,
    { name: "duty-loop", role: "duty-loop", cwd, env, group },
    `${d.doriCmd} duty --interval 60`,
  );
  d.store.setRole("duty-loop", loop);
  const hourly = await openSession(
    rt,
    { name: "hourly-loop", role: "hourly-loop", cwd, env, group },
    `${d.doriCmd} loop`,
  );
  d.store.setRole("hourly-loop", hourly);
  console.log(
    `UP runtime=${rt.kind} lead=${refText(lead)} duty=${refText(duty)} loop=${refText(loop)} hourly=${refText(hourly)} home=${d.store.root}`,
  );
}

/** The runtime line first (a runtime that cannot be chosen is shown, not thrown; a bad setting still throws). */
function runtimeLine(d: Deps): string {
  try {
    const c = d.choice();
    return `RUNTIME ${c.kind} (from ${c.source})`;
  } catch (e) {
    if (e instanceof RuntimeChoiceError) return `RUNTIME unset: ${e.message}`;
    throw e;
  }
}

export function status(d: Deps): void {
  console.log(runtimeLine(d));
  const roles = d.store.roles();
  const show = (ref: SessionRef | undefined) => (ref ? refText(ref) : "-");
  console.log(`lead=${show(roles.lead)} duty=${show(roles.duty)} home=${d.store.root}`);
  for (const l of d.store.lanes()) {
    const last = l.log.at(-1);
    const age = Math.round((d.now() - l.lastActivityAt) / 60_000);
    console.log(
      `${l.key.padEnd(24)} ${l.status.padEnd(8)} ${l.sessionRef.runtime.padEnd(5)} ${refText(l.sessionRef).padEnd(14)} active ${age}m ago  ${last ? `${last.kind}: ${last.text.slice(0, 60)}` : ""}`,
    );
  }
}
