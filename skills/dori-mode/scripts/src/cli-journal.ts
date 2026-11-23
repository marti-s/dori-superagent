/** dori report, lesson, worklog, checkpoint and checkpoints: the durable journals. */
import { CheckpointError, Checkpoints } from "./checkpoints.ts";
import { type Cli, type Command, die } from "./cli-context.ts";
import { isLessonOutcome, LessonError, Lessons } from "./lessons.ts";
import { isReportKind, ReportError, Reports, reportLine } from "./reports.ts";
import { realClock, runtimesOf } from "./run.ts";
import { Worklog, WorklogError } from "./worklog.ts";

/** Journal errors are the user's input refused: one line, never a stack. */
export const journalErrors = [CheckpointError, LessonError, ReportError, WorklogError] as const;

const report: Command = async ({ key, need, lane, config }) => {
  const target = await lane(key ?? die("report needs a lane key"));
  const kind = need("kind");
  if (isReportKind(kind)) {
    console.log(reportLine(new Reports(config.stateDir).report(target.key, kind, need("text"), realClock.now())));
  } else die("--kind must be milestone, blocker, question, halted or done");
};

const lessonAdd = async (
  { positionals, values, opt, need, deps, config }: Cli,
  lessons: Lessons,
  paneLane: () => Promise<{ readonly key: string } | null>,
) => {
  const laneKey = positionals[1];
  if (values["global"]) {
    // A global lesson reaches every future brief, so it is the lead's: it takes no lane key and is recorded
    // as the lead's. paneLane() refuses it from a registered lane's pane.
    if (laneKey !== undefined) die("a --global lesson is the lead's: give no lane key");
    if (opt("cwd") !== undefined) die("a --global lesson has no --cwd");
    const caller = await paneLane();
    if (caller) die(`a --global lesson is the lead's; this pane is lane ${caller.key}`);
    console.log(
      JSON.stringify(
        lessons.add({ lane: "lead", scope: "global", rule: need("rule"), evidence: need("evidence") }, realClock.now()),
      ),
    );
    return;
  }
  const target =
    laneKey === undefined ? undefined : ((await deps.registry.read(laneKey)) ?? die(`no registered lane "${laneKey}"`));
  const repoLane = target ?? die("lesson add needs a lane key, or --global");
  console.log(
    JSON.stringify(
      lessons.add(
        {
          lane: repoLane.key,
          cwd: opt("cwd") ?? repoLane.cwd ?? config.defaultCwd,
          rule: need("rule"),
          evidence: need("evidence"),
        },
        realClock.now(),
      ),
    ),
  );
};

const lesson: Command = async (cli) => {
  const { key, positionals, opt, need, deps, config } = cli;
  const lessons = new Lessons(config.stateDir);
  // The open lane that owns the caller's own session (HC_TERMINAL_ID). A convenience check:
  // it stops a lane from adding or reviving a global lesson by accident or on routine instruction. It is not a
  // security boundary, since it reads only those session variables (unsetting them gets past it) and a direct write to
  // lessons.jsonl skips the CLI.
  const paneLane = async () => {
    return await deps.registry.bySession(runtimesOf(deps).selfAny(process.env));
  };
  switch (key) {
    case "add":
      return await lessonAdd(cli, lessons, paneLane);
    case "list": {
      const read = lessons.read(opt("cwd"));
      for (const problem of read.problems) console.error(`LESSON_WARNING ${problem}`);
      console.log(JSON.stringify(read.lessons, null, 2));
      return;
    }
    case "mark": {
      const id = positionals[1] ?? die("lesson mark needs a lesson id");
      // Marking a global lesson helped or pending puts it back into every brief, so a lane cannot mark one.
      // Repo lessons stay markable from lanes.
      if (lessons.read().lessons.find((lesson) => lesson.id === id)?.scope === "global") {
        const caller = await paneLane();
        if (caller) die(`a global lesson is the lead's to mark; this pane is lane ${caller.key}`);
      }
      const outcome = need("outcome");
      if (isLessonOutcome(outcome)) console.log(JSON.stringify(lessons.mark(id, outcome)));
      else die("--outcome must be pending, helped, no-effect, harmful or encoded");
      return;
    }
    default:
      die("lesson needs add, list or mark");
  }
};

const worklog: Command = async ({ key, positionals, values, need, config }) => {
  const worklog = new Worklog(config.stateDir);
  const id = () => positionals[1] ?? die(`worklog ${key} needs an item id`);
  const text = () => positionals.slice(2).join(" ").trim() || die(`worklog ${key} needs text`);
  const now = realClock.now();
  switch (key) {
    case "add":
      console.log(
        JSON.stringify(
          worklog.add(positionals.slice(1).join(" ").trim() || die("worklog add needs a title"), need("source"), now),
        ),
      );
      break;
    case "next":
      console.log(JSON.stringify(worklog.next(id(), text(), now)));
      break;
    case "note":
      console.log(JSON.stringify(worklog.note(id(), text(), now)));
      break;
    case "close":
      console.log(JSON.stringify(worklog.close(id(), need("result"), now)));
      break;
    case "list": {
      const read = worklog.read();
      for (const problem of [...read.problems, ...read.warnings]) console.error(`WORKLOG_WARNING ${problem}`);
      console.log(
        JSON.stringify(values["open"] ? read.items.filter((item) => item.closedAt === undefined) : read.items, null, 2),
      );
      break;
    }
    default:
      die("worklog needs add, next, note, close or list");
  }
};

const checkpoint: Command = async ({ key, positionals, need, strings, lane, config }) => {
  const target = await lane(key ?? die("checkpoint needs a lane key"));
  // parseArgs takes one value per flag; a second bare receipt would otherwise be dropped and its effect repeated later.
  const stray = positionals.slice(1);
  if (stray.length) die(`checkpoint: unexpected argument ${stray[0]}; give each receipt its own --remote-effect`);
  const result = new Checkpoints(config.stateDir).write(
    target.key,
    {
      step: need("step"),
      result: need("result"),
      evidence: [need("evidence")],
      remoteEffects: strings("remote-effect"),
    },
    realClock.now(),
  );
  console.log(JSON.stringify(result));
};

export const journalCommands: Readonly<Record<string, Command>> = {
  report,
  lesson,
  worklog,
  checkpoint,
  checkpoints: async ({ key, deps, config }) => {
    if (!key || !(await deps.registry.read(key))) die("checkpoints needs a registered lane key");
    console.log(JSON.stringify(new Checkpoints(config.stateDir).read(key ?? ""), null, 2));
  },
};
