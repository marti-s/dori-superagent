import { readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { shq } from "./delivery.ts";
import { memFreePct } from "./host.ts";
import { Refusal } from "./refusal.ts";
import { type Exec, spawnExec } from "./runtime/exec.ts";
import { HcRuntime } from "./runtime/hc/index.ts";
import { Runtimes } from "./runtime/registry.ts";
import { type RuntimeChoice, readRuntimeChoice } from "./runtime/select.ts";
import { Store } from "./store.ts";
import { type HostLoad, KEY_RE, type Role, reservedKey } from "./store-types.ts";
import { Telemetry, type Usage } from "./telemetry.ts";

export { KEY_RE, reservedKey };

const PROMPTS = join(import.meta.dir, "..", "prompts");
const CLI = resolve(import.meta.dir, "cli.ts");

export type Deps = {
  readonly store: Store;
  /** The session runtimes: `default` opens new sessions, `for(ref)` reaches a stored one on its own runtime. */
  readonly runtimes: Runtimes;
  /** Which runtime new sessions open on, and why (`dori status` prints it). Throws when none can be chosen. */
  readonly choice: () => RuntimeChoice;
  readonly exec: Exec;
  readonly now: () => number;
  readonly agentCmd: string;
  /** How long one reviewer run may take before it is killed and the review fails. */
  readonly reviewTimeoutMs: number;
  /** How long after a lane is done or lost the duty loop retires its terminal and tab; 0 never retires them. */
  readonly tabCloseDelayMs: number;
  readonly doriCmd: string;
  readonly host: () => HostLoad;
  readonly usage: Usage;
};

/** The runtime is chosen on first use, so commands that open or reach no session work without one installed. */
export const defaultDeps = (): Deps => {
  const store = new Store();
  let chosen: RuntimeChoice | undefined;
  let runtimes: Runtimes | undefined;
  const choice = (): RuntimeChoice =>
    (chosen ??= readRuntimeChoice({ env: process.env, configPath: join(store.root, "config.json") }));
  return {
    store,
    get runtimes() {
      // The choice is made only when a NEW session is opened: a stored session's own runtime needs none.
      runtimes ??= new Runtimes(
        () => choice().kind,
        () => new HcRuntime(spawnExec),
      );
      return runtimes;
    },
    choice,
    exec: spawnExec,
    now: Date.now,
    agentCmd: process.env["DORI_AGENT_CMD"] ?? "omo",
    reviewTimeoutMs: reviewTimeoutMinutes(process.env["DORI_REVIEW_TIMEOUT_MIN"]) * 60_000,
    tabCloseDelayMs: tabCloseMinutes(process.env["DORI_TAB_CLOSE_MIN"]) * 60_000,
    doriCmd: process.env["DORI_CMD"] ?? `DORI_HOME=${shq(store.root)} bun ${shq(CLI)}`,
    host: () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length, memFreePct: memFreePct() }),
    usage: new Telemetry(store.root),
  };
};

const REVIEW_TIMEOUT_MIN = 25;
const TAB_CLOSE_MIN = 15;

/** DORI_TAB_CLOSE_MIN as minutes, 0 to never close; unset means 15, a negative or non-number is refused. */
export function tabCloseMinutes(raw: string | undefined): number {
  if (raw === undefined || raw === "") return TAB_CLOSE_MIN;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0)
    throw new Refusal(`DORI_TAB_CLOSE_MIN must be 0 or a positive number of minutes, not ${JSON.stringify(raw)}`);
  return minutes;
}

/** DORI_REVIEW_TIMEOUT_MIN as a positive number of minutes; unset means 25, anything else is refused. */
export function reviewTimeoutMinutes(raw: string | undefined): number {
  if (raw === undefined || raw === "") return REVIEW_TIMEOUT_MIN;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0)
    throw new Refusal(`DORI_REVIEW_TIMEOUT_MIN must be a positive number of minutes, not ${JSON.stringify(raw)}`);
  return minutes;
}

/** `DORI_PROMPTS_DIR` when set, else the repo's `prompts/`. */
export const promptsDir = (): string => process.env["DORI_PROMPTS_DIR"] || PROMPTS;

export const prompt = (name: string, vars: Record<string, string>): string =>
  readFileSync(join(promptsDir(), name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

/** The roles `dori role` registers by hand; `dori up` also registers the two loop sessions. */
export const ROLES: readonly Role[] = ["lead", "duty"];
