import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { RuntimeKind } from "./types.ts";

export type RuntimeSource = "env" | "config" | "detect:HC_TERMINAL_ID" | "detect:path";
export type RuntimeChoice = { readonly kind: RuntimeKind; readonly source: RuntimeSource };

/** No runtime could be chosen; the message is the one-line fix. */
export class RuntimeChoiceError extends Error {}
/** A runtime setting that is present but unusable (bad value, unreadable config file). */
export class ConfigError extends Error {}

// A record keyed by kind, so a new RuntimeKind cannot be left out here.
const KIND_SET: Readonly<Record<RuntimeKind, true>> = { hc: true };
const KINDS = Object.keys(KIND_SET) as RuntimeKind[];
const isKind = (value: unknown): value is RuntimeKind => KINDS.some((k) => k === value);

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

function configRuntime(configPath: string): RuntimeKind | undefined {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return undefined;
    throw new ConfigError(`cannot read ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${configPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new ConfigError(`${configPath} must hold a JSON object`);
  if (!("runtime" in parsed)) return undefined;
  const value: unknown = parsed.runtime;
  if (!isKind(value)) throw new ConfigError(`${configPath}: "runtime" must be "hc", got ${JSON.stringify(value)}`);
  return value;
}

function onPath(pathVar: string | undefined, exists: (path: string) => boolean): RuntimeKind[] {
  const dirs = (pathVar ?? "").split(delimiter).filter((dir) => dir !== "");
  return KINDS.filter((kind) => dirs.some((dir) => exists(join(dir, kind))));
}

/**
 * Which runtime new sessions open on, and why. hc (herdr-core) is the only one, so every source names it:
 * `DORI_RUNTIME` > the config file's `runtime` key > `HC_TERMINAL_ID` (inside an hc terminal) > the `hc` binary on
 * PATH. Any other value of a setting is refused, and no `hc` with nothing else set is refused with the fix in one line.
 */
export function readRuntimeChoice(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly configPath: string;
  readonly exists?: (path: string) => boolean;
}): RuntimeChoice {
  const { env, configPath } = options;
  const fromEnv = nonEmpty(env["DORI_RUNTIME"]);
  if (fromEnv !== undefined) {
    if (!isKind(fromEnv)) throw new ConfigError(`DORI_RUNTIME must be "hc", got ${JSON.stringify(fromEnv)}`);
    return { kind: fromEnv, source: "env" };
  }
  const fromConfig = configRuntime(configPath);
  if (fromConfig !== undefined) return { kind: fromConfig, source: "config" };
  if (nonEmpty(env["HC_TERMINAL_ID"]) !== undefined) return { kind: "hc", source: "detect:HC_TERMINAL_ID" };
  if (onPath(env["PATH"], options.exists ?? isExecutableFile).includes("hc"))
    return { kind: "hc", source: "detect:path" };
  throw new RuntimeChoiceError("hc is not on PATH: install hc (herdr-core)");
}
