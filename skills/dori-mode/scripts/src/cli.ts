#!/usr/bin/env bun
import { parseArgs } from "node:util";

import { type Command, die, makeCli } from "./cli-context.ts";
import { journalCommands, journalErrors } from "./cli-journal.ts";
import { laneCommands } from "./cli-lanes.ts";
import { messengerCommands, messengerErrors } from "./cli-messenger.ts";
import { opsCommands } from "./cli-ops.ts";
import { ConfigError, loadConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { LaunchError } from "./launch.ts";
import { Registry } from "./registry.ts";
import { realClock, run } from "./run.ts";

const USAGE = `dori <command> [options]

  launch <key> --title T --brief FILE --done "merged o/r#N; closed o/r#M" [--thread REF] [--model M] [--cwd DIR]
         [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none] [--activity-path FILE ...] [--dry-run]
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF]
  sync   [--write]                     registry vs live panes; read-only unless --write
  boot                                 read-only check after a restart: Slack auth, vanished panes, journals, open worklog items, stale watches
  report <key> --kind milestone|blocker|question|halted|done --text TEXT
                                       append a durable progress report and print its [REPORT] line
  checkpoint <key> --step ID --result TEXT --evidence PATH [--remote-effect RECEIPT]...
                                       record a completed step once; a conflicting rewrite is refused
  checkpoints <key>                    read completed steps before resuming remote work
  verify-pr <owner/repo> <num> [--loop N] [--cwd DIR]
                                       check every commit's author/committer email and PR-level tests; print the UI test loop (not run)
  claim-done [<key>] --evidence TEXT  key defaults to the lane registered for your own session (HC_TERMINAL_ID or HERDR_PANE_ID)
  object-done <key> --reason TEXT [--reason TEXT ...]
  lesson add <key> --rule TEXT --evidence PATH [--cwd DIR]
  lesson add --global --rule TEXT --evidence REF
                                       the lead's lesson for every lane, whatever its repo
  lesson list [--cwd DIR]             show current lessons (global ones included), newest first
  lesson mark <id> --outcome pending|helped|no-effect|harmful|encoded
  worklog add <title> --source REF     record an owner request when it arrives
  worklog next|note <id> <text>        set the item's next step, or add a note (a decision, an owner)
  worklog close <id> --result TEXT     close the item with what came of it
  worklog list [--open]                items as JSON; <stateDir>/worklog.md holds the same for reading
  close  <key> [--note TEXT] [--lesson TEXT] [--evidence PATH]
                                       close now (Done signals must read back live); an optional lesson never blocks it
  pause  <key> [--note TEXT]           the owner said wait: goal paused (read back), running turn stopped, no nudges; exit 3 if unconfirmed
  resume <key> [--note TEXT]           undo pause: goal resumed (read back), lane back to its earlier status
  watch                                long-running: emits LANE_* lines every 30 s
  freshness [--loop MIN]               nudge silent lanes, post their last report via hooks.threadReply
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> -- <command ...>       run a heavy command when a slot is free and load is low
  can-launch                           exit 0 if the host has room for a new lane, else print why and exit 4
  send <slack|telegram|discord> --to TARGET --text TEXT [--thread ID] [--edit ID]
                                       post or edit a message (tokens from DORI_SLACK_TOKEN or the file DORI_SLACK_TOKEN_FILE names, DORI_TELEGRAM_TOKEN, DORI_DISCORD_TOKEN)
  presence <slack|discord>             keep the account shown as online until stopped
  transcribe <audio-file>              run hooks.transcribe and print the text
  inbound slack|telegram [--loop MIN]  print INBOUND lines: Slack unread thread replies / Telegram owner DMs, edits and media + configured topic
                                       the Dori posted in (any helper), DMs and channels with unread mentions`;

const config = await loadConfig().catch((e: unknown) =>
  e instanceof ConfigError ? die(e.message) : Promise.reject(e),
);
const deps: FlowDeps = { run, clock: realClock, registry: new Registry(config.stateDir), config };
const [command = "", ...rest] = process.argv.slice(2);

const flags = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  options: {
    title: { type: "string" },
    brief: { type: "string" },
    done: { type: "string" },
    thread: { type: "string" },
    model: { type: "string" },
    cwd: { type: "string" },
    pane: { type: "string" },
    evidence: { type: "string" },
    reason: { type: "string", multiple: true },
    note: { type: "string" },
    write: { type: "boolean" },
    loop: { type: "string" },
    to: { type: "string" },
    text: { type: "string" },
    edit: { type: "string" },
    kind: { type: "string" },
    step: { type: "string" },
    result: { type: "string" },
    "remote-effect": { type: "string", multiple: true },
    "wall-minutes": { type: "string" },
    "token-limit": { type: "string" },
    "cost-limit": { type: "string" },
    "activity-path": { type: "string", multiple: true },
    rule: { type: "string" },
    outcome: { type: "string" },
    lesson: { type: "string" },
    "dry-run": { type: "boolean" },
    global: { type: "boolean" },
    source: { type: "string" },
    open: { type: "boolean" },
  },
});

const commands: Readonly<Record<string, Command>> = {
  ...journalCommands,
  ...laneCommands,
  ...opsCommands,
  ...messengerCommands,
};
const handler = Object.hasOwn(commands, command) ? commands[command] : undefined;

try {
  if (handler) await handler(makeCli(command, rest, flags, config, deps));
  else {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
} catch (e) {
  if (e instanceof LaunchError || [...messengerErrors, ...journalErrors].some((type) => e instanceof type))
    die((e as Error).message);
  throw e;
}
