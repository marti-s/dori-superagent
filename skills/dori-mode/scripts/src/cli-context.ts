/** What every dori command handler gets: the parsed flags, the config, the flow deps, and the small helpers. */
import type { DoriConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { SlackAuth } from "./messenger/slack.ts";
import { type Lane, statusOf } from "./registry.ts";
import { runtimesOf } from "./run.ts";
import { slackToken } from "./slack-token.ts";

export const die = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

/** Slack credentials from the environment; the cookie is optional. */
export const slackAuth = (token: string): SlackAuth => {
  const cookie = process.env["DORI_SLACK_COOKIE"];
  return { token, ...(cookie !== undefined ? { cookie } : {}) };
};

/** The Slack token from DORI_SLACK_TOKEN or the file DORI_SLACK_TOKEN_FILE names; a bad token file is refused. */
export const envSlackToken = (): string | undefined => {
  try {
    return slackToken();
  } catch (e) {
    return die(e instanceof Error ? e.message : String(e));
  }
};

export const every = async (minutes: number, tick: () => Promise<void>): Promise<void> => {
  for (;;) {
    await tick().catch((e: unknown) => console.log(`WARN ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)));
    if (minutes <= 0) return;
    await Bun.sleep(minutes * 60_000);
  }
};

type FlagValues = Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;

export type Cli = {
  readonly command: string;
  readonly rest: readonly string[];
  readonly key: string | undefined;
  readonly positionals: readonly string[];
  readonly values: FlagValues;
  readonly config: DoriConfig;
  readonly deps: FlowDeps;
  readonly opt: (name: string) => string | undefined;
  readonly need: (name: string) => string;
  readonly strings: (name: string) => string[];
  readonly ceiling: (name: string) => number | null | undefined;
  readonly loopMinutes: () => number;
  readonly lane: (k: string | undefined) => Promise<Lane>;
};

export type Command = (cli: Cli) => Promise<void>;

export const makeCli = (
  command: string,
  rest: readonly string[],
  flags: { readonly values: FlagValues; readonly positionals: readonly string[] },
  config: DoriConfig,
  deps: FlowDeps,
): Cli => {
  const opt = (name: string): string | undefined => {
    const v = flags.values[name];
    return typeof v === "string" ? v.trim() : undefined;
  };
  const need = (name: string): string => opt(name) || die(`--${name} is required`);
  // Bun.sleep(NaN) returns at once, so a --loop such as "5m" would run the watch's ticks back to back.
  // A bare --loop or an empty value would read as 0, so only a missing flag means one-shot.
  const loopMinutes = (): number => {
    if (flags.values["loop"] === undefined) return 0;
    const value = opt("loop");
    const minutes = Number(value);
    return value && Number.isFinite(minutes) && minutes >= 0
      ? minutes
      : die("--loop must be a number of minutes, 0 or more");
  };
  const strings = (name: string): string[] => {
    const value = flags.values[name];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  };
  const ceiling = (name: string): number | null | undefined => {
    const value = opt(name);
    if (value === undefined) return undefined;
    if (value === "none") return null;
    const parsed = Number(value);
    return value && Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : die(`--${name} must be a nonnegative number or none`);
  };
  const lane = async (k: string | undefined): Promise<Lane> => {
    const found = k
      ? await deps.registry.read(k)
      : await deps.registry.bySession(runtimesOf(deps).selfAny(process.env));
    if (!found) return die(k ? `no registered lane "${k}"` : "no open lane is registered for this pane");
    if (statusOf(found) === "closed") return die(`lane ${found.key} is already closed`);
    return found;
  };
  return {
    command,
    rest,
    key: flags.positionals[0],
    positionals: flags.positionals,
    values: flags.values,
    config,
    deps,
    opt,
    need,
    strings,
    ceiling,
    loopMinutes,
    lane,
  };
};
