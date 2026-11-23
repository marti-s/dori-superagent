# The session runtime: hc

**Dori runs its sessions on hc (herdr-core), and shows them as tabs in the Herdr app. hc is the only runtime: no other terminal backend is started or reached.**

A session is one terminal with an agent or a loop in it: the lead, duty, the duty loop, the hourly loop, or a lane. hc gives Dori plain terminals with labels, and the agent in a terminal reports its own status. The Herdr app is the window: it shows each terminal as a tab, and Dori drives it with `herdr-app`. The harness and the dori-mode skill reach hc through one interface, so the commands and the files under `DORI_HOME` do not name hc verbs.

## The interface

`SessionRuntime` in `src/runtime/types.ts` is the whole contract, and `src/runtime/hc/` is its adapter. The adapter runs `hc` and `herdr-app` through one injectable process runner (`src/runtime/exec.ts`), so tests replace the binaries with a recorder.

| Method | What it does |
|---|---|
| `self()` | The caller's own session, from `HC_TERMINAL_ID` |
| `create(spec)` | A terminal with the user's shell in it and nothing started, placed in a Herdr app space, its tab named |
| `start(ref, command)` | Runs the command line in that shell |
| `list(filter)` | The live sessions, all of them or one group's |
| `probe(ref)` | One snapshot: status, agent name, foreground process, title, cwd |
| `read(ref, lines)` | The last lines of the screen |
| `deliver(ref, text, opts)` | One message to the agent; never types into a shell |
| `submitTyped(ref, into)` | Always answers `changed`: hc never leaves typed text waiting for an Enter |
| `typeIntoShell(ref, text)` | The operator's `--to-shell`, only into a session with no agent |
| `keys(ref, keys)` | Enter or Escape |
| `stop(ref)` | Ends the terminal's program and keeps the terminal, so its screen stays readable |
| `close(ref)` | Ends the program and removes the terminal |
| `retire(ref, laneKey)` | Removes a closed lane's terminal and closes its Herdr tab |

A session is stored as a `SessionRef`: the runtime (`hc`), the terminal address (`t7`), and the group it was listed under. Dori stores and prints a session as its bare address: `roles.json` holds `"lead": "t7"`, an inbox file is `inbox/t7.jsonl`, and `dori start` prints `pane=t7`. A lane record with no ref is read as the hc terminal its `paneId` names.

## Choosing the runtime

hc is the only choice, and `readRuntimeChoice` in `src/runtime/select.ts` says where it came from, in this order:

1. `DORI_RUNTIME=hc`.
2. `"runtime": "hc"` in `$DORI_HOME/config.json` (default `~/.dori/config.json`). This is the same file the dori-mode skill reads, so one line sets both.
3. `HC_TERMINAL_ID` is set: Dori runs inside an hc terminal.
4. `hc` is on PATH.

Any other value in `DORI_RUNTIME` or in the config file is an error, never a fallback:

```
DORI_RUNTIME must be "hc", got "tmux"
```

When `hc` is not on PATH and nothing above decides, Dori refuses and prints the fix in one line:

```
hc is not on PATH: install hc (herdr-core)
```

`dori status` prints the choice first, as `RUNTIME hc (from config)`; the sources are `env`, `config`, `detect:HC_TERMINAL_ID` and `detect:path`. When no runtime can be chosen, it prints `RUNTIME unset:` and the fix. The dori-mode skill's `dori boot` prints the same `RUNTIME` line, or `RUNTIME unavailable:` and fails its check.

## The hc and herdr-app calls

Every `hc` call carries `--json`.

| Call | Used for |
|---|---|
| `hc run --bg --no-parent --no-notify --cwd D --label dori.group=G ... -- env K=V $SHELL` | Opening a session: the lead, duty, the loops, lanes |
| `hc send <t> -- <command>` | Starting the agent or loop in the new shell |
| `hc get <t>` | The status word, the agent name, the foreground process, the labels and the launch argv |
| `hc read <t> --lines N` | Screen reads (launch checks, the idle check) |
| `hc send <t> [--if idle\|working] [--force] -- <text>` | Delivering a message: hc pastes and presses Enter in one step |
| `hc keys <t> enter` | Enter; Escape is `esc` |
| `hc ls [--label dori.group=G]` | Listing sessions |
| `hc ls --label herdr.space=<id>` | Finding the space `DORI_HERDR_SPACE` names |
| `hc kill <t>` | Stopping a session |
| `hc kill <t>`, then `hc rm <t>` | Closing or retiring a session |
| `herdr-app ls` | Finding the tab that holds a terminal |
| `herdr-app do tab.rename --id <tab> --name <name>` | Naming a new session's tab |
| `herdr-app do tab.close --id <tab> --confirmed true` | Closing a retired lane's tab |

`hc rm` answers `live` while the program is still dying, so Dori retries it 5 times, 200 ms apart, and logs one line if the terminal is still running after that. `HC_SESSION=<name>` in the environment selects an isolated core, as the end-to-end test uses.

## Placement and tab names

hc's server does not inherit the caller's environment, so a new terminal is started with the caller's `DORI_*` settings and `PATH` under the session's own variables (`DORI_HOME`, and `DORI_LANE` for a lane). The caller's `DORI_LANE` is never passed on: it names the caller's own lane.

Every terminal Dori opens joins one space of the Herdr app, the first that applies:

1. `DORI_HERDR_SPACE=<herdr.space id>`. Dori refuses to open anything when no terminal is in that space.
2. The space of the terminal Dori is started from (`HC_TERMINAL_ID`).

The terminal is labelled `herdr.space=<id>` and `where=<space name> / dori-<tab>`. With neither, the terminal is started with no placement and `herdr-app` is not called.

A placed terminal's tab is then named: `lead`, `duty`, `duty-loop` and `hourly-loop` for the sessions `dori up` opens, and the lane key for a lane. The window lists a new terminal a moment after hc starts it, so Dori looks the tab up again, up to 10 times 200 ms apart. Naming is best effort: a missing `herdr-app`, a closed window or a tab that never appears is one line on stderr, and the session is started all the same. `DORI_HERDR_APP` is the path of `herdr-app` when it is not on PATH.

## Status

Dori reads a session's status before it types anything into it. The words are `idle`, `working`, `blocked`, `done`, `error`, `unknown`, `shell` (no agent, a bare shell) and `gone` (the terminal finished or hc no longer knows it).

The status comes from the agent's own report, an OSC 7501 escape sequence. omo reports `working` for as long as any monitor or background session is live, even between turns (#178), so when an agent with no shell in front reports `working`, Dori also reads the last 30 screen lines and believes `idle` only when omo's empty input box is at the bottom; a failed or empty read stays `working`. Recent omo builds emit that report. An agent that never reports stays `unknown`, or `shell` when an interactive shell leads the foreground, and Dori holds every message to it in its inbox without sending. For a reporting agent Dori probes first and then sends with a gate. The inbox, the one path that types queued messages into an agent, sends its batch with `--if idle`, or with `--if working` when the idle came from the screen while hc still says `working`; when hc refuses because the agent moved in between, the batch stays queued and the next flush tries again. That second gate cannot tell a new turn from the idle state, because omo reports `working` for both: a turn that starts in the one hc round trip between the screen read and the send still gets the batch. The dori-mode scripts' direct sends and the migration checkpoint ask gate on the status they just read instead, `--if idle` after `idle` and `--if working` after `working`. A refused send comes back to the script as `failed`; a send whose outcome cannot be known (an ambiguous delivery, or any send made while the agent was working) comes back as `unconfirmed`, and the script never resends it. The migration ask treats only a gone agent as a stop; a refused or unconfirmed ask is not surfaced yet (tracked as a follow-up). An agent that reports `done` (its turn finished, waiting for input) is sent to without a gate, because hc's `--if` accepts only `idle` and `working`. A `blocked` or `error` agent gets nothing unless the sender forces it. A suspended agent leaves its shell in front, and Dori then holds the message whatever the status word says.

Set `notes = false` in `~/.config/herdr-core/config.toml`. With notes on, hc types notes into a parent agent on its own, and Dori's inbox is meant to be the only thing that types into an agent. Dori already opens every terminal with `--no-parent --no-notify`.

## Closing and retiring a lane

`dori done` stops the lane's terminal with `hc kill` and keeps it, so the lane's last screen can still be read. A lane whose terminal finished or disappeared before READY is marked `lost`.

`DORI_TAB_CLOSE_MIN` minutes (default 15, `0` for never) after a lane is done or lost, the duty loop retires it: it removes the terminal and closes its tab. hc may hand a removed address to a new terminal, so Dori touches only the terminal it started for that lane, the one whose launch argv carries `DORI_LANE=<key>`. It never touches the lead's, duty's or a loop's terminal, and it keeps a tab that still holds another live terminal. The window drops a tab once hc removes its last terminal, so a close it refuses for a tab it no longer lists counts as closed. What was done is written to the lane's log.

## Grouping

Dori opens one terminal per session and labels it:

- `dori.group`: the home's group, the first 8 hex characters of the sha256 of the resolved `DORI_HOME` path, so two homes never share one;
- `dori.role`: `lead`, `duty`, `duty-loop`, `hourly-loop` or `lane`;
- `dori.name`: the session's name;
- `dori.lane`: the lane key, on lanes only.

`hc ls --label dori.group=<g>` lists one home's sessions. The terminal also gets the session name as its hc name when no live terminal holds it, but Dori identifies a terminal by its address and labels, never by the name.

Only one duty loop runs per home: it takes `duty/lock` under `DORI_HOME`, and a second `dori duty` is refused while it is held.

## Targets

`dori send`, `dori role` and `dori inbox` take a session in several forms, tried in this order:

- `hc:t7`, with the runtime spelled out;
- `lead` or `duty`;
- a lane key;
- a bare `t7`, the terminal's address.

`t7` is also a legal lane key, so a lane named `t7` is that lane, and the terminal t7 is then `hc:t7`.

## Hooks and prompts

`$DORI_HOME/config.json` can also hold `hooks`, argv templates that run without a shell:

```json
{
  "runtime": "hc",
  "hooks": {
    "onReady": ["notify-send", "READY {key}", "{text} {evidence}"],
    "onReport": ["logger", "-t", "dori", "{key}: {text}"],
    "onLost": ["logger", "-t", "dori", "LOST {key}: {text}"],
    "reviewCommand": ["my-reviewer", "--pr", "{pr}", "--sha", "{sha}"]
  }
}
```

`onReady` runs on `dori ready`, `onReport` on `dori report`, and `onLost` when a lane's terminal finished or vanished before READY. `{key}`, `{text}` and `{evidence}` are replaced inside each element. Hooks run in the background, and a failing hook is one stderr line; it never fails the command. `reviewCommand` replaces the built-in reviewer in `dori review`, gets `{pr}`, `{repo}`, `{number}`, `{sha}` and `{text}` (the rendered review prompt), and must print a `VERDICT: CLEAR` or `VERDICT: BLOCK` line. `DORI_PROMPTS_DIR` points Dori at another directory of prompt files in place of the repo's `prompts/`.

## Limits

- No remote sessions. hc can run terminals on other machines (`--on`), and Dori does not use it: every session is on the local core, and `dori` ignores terminals mirrored from other machines.
- Dori does not create spaces or arrange windows. It joins a space of the Herdr app that already exists; outside the app, open a terminal with `hc attach <t>`.
- hc on Windows is untested here.

## Tests

`bun test ./test/` covers the adapter against a recorder that stands in for `hc` and `herdr-app`. One end-to-end test, `test/e2e-hc.test.ts`, runs a real hc core in an isolated session (its own `HC_SESSION` and XDG directories) with a fixture agent that reports OSC 7501. It is skipped when `hc` is not on PATH.
