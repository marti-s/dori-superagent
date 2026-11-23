# Hourly loop

`dori loop` is an always-on process that wakes once an hour, checks the harness against reality, and starts the next piece of work that needs nobody's decision. `dori up` starts it in a pane under the duty loop. The duty loop works in minutes (nudges, inbox flushes). The hourly loop works in hours: it decides what runs next.

## Where the next work comes from

A local backlog under `$DORI_HOME/backlog/`: one `<id>.json` and one `<id>.md` brief per item, where the item id becomes the lane key. Items are added by the lead (`dori backlog add`) or imported from GitHub issues carrying a label (`dori backlog import owner/repo --label dori`). The loop picks what to start only from the local backlog. GitHub is one source that feeds it, and the sync step reads PR and issue state from GitHub to retire finished items.

An item that needs a person carries a `decision` (the question). While it is set, the item is never started. `dori backlog decide <id> --text ANSWER` clears it and appends the answer to the item's brief, so the lane that later runs it sees the answer. `dori backlog drop <id>` retires the item.

## One run, in order

0. Gate. A stop file means do nothing at all. A live lock held by another process means skip; a lock whose process is dead, or whose contents are corrupt, is taken over. A run less than an interval (default one hour) after the last one means skip, unless `--force`. A skipped run writes no record.
1. Sync. A running item whose lane is done becomes done. One whose lane was lost, or whose lane record is missing, goes back to open with one more attempt, and after 2 such attempts it gets a decision ("retry, re-brief or drop?"). One whose lane is READY with a merged PR becomes done. An open item imported from an issue that is now closed is dropped.
2. Audit. Read-only checks: a working or waiting lane whose last start or report is 3 hours old (the duty loop polling a busy pane does not count as a report), a READY lane not closed after 2 hours, a lane whose pane is gone.
3. Pull. Free slots = `--max-lanes` (default 3) minus open lanes, and at most `--max-starts` (default 2) per run. Nothing starts when the 1-minute load is above the core count (or `--max-load`) or available memory is under 10% (on macOS the kernel's available-memory level, `kern.memorystatus_level`, because free pages alone sit near zero there). Candidates are open items with no decision, ordered by priority (1 first), then age, then id.
4. Ask. Each open decision is asked once through the lead as a `[DECIDE <id>]` line, with at most one reminder after 6 hours.
5. Record and report. The run is written to `loop/runs/<time>.json` (the newest 168 are kept) and `loop/last-run.json`, then one `[LOOP ...]` message goes to the lead: lanes against the limit, backlog counts, host load and memory, and each non-empty section.

## Safety

- The loop's only side effects are opening lanes (`dori start`), messages to the lead, and its own files. It never merges, never pushes, never closes a pane and never edits an open lane's record; retrying a lost item starts a fresh lane under the same key, which replaces the lost lane's record. Its `gh` calls are reads.
- Only the lead talks to the human. Questions reach the human through the lead.
- Kill switch: `dori loop stop [--text WHY]` writes `loop/stop`. Until `dori loop resume`, every run does nothing. The backlog can still be edited while it is stopped.
- One loop at a time: the lock is created whole with a hard link and taken over with a rename only one process can win, a run checks it still holds the lock before each start, and the last-run stamp keeps a second loop or a cron `--once` from running the same hour twice.
- A failing `gh` or hc call becomes a finding in the record and the run goes on, including a failure to deliver the report to the lead. A failed lane start uses up that slot and the loop moves on to the next item; after 2 failed starts the item becomes a question, so it never blocks the items behind it. A lane that opened but whose `[START]` did not reach the lead still counts as started. A stopped, locked-out or failing loop waits a full interval before it checks again. `dori loop --once` exits 1 when a run throws, so cron sees the failure.
