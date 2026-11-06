// What the harness needs from a terminal backend, and the delivery rules every backend shares. Every command goes
// through one injectable `Exec`, so tests can replace the binaries with a recorder.

export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
export type Exec = (cmd: string, argv: readonly string[]) => Promise<ExecResult>;

export const spawnExec: Exec = async (cmd, argv) => {
  const proc = Bun.spawn([cmd, ...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/** A command that exited non-zero. The message carries argv (which may hold delivered text); `result` has its own output. */
export class CommandError extends Error {
  constructor(readonly command: string, readonly argv: readonly string[], readonly result: ExecResult) {
    super(`${command} ${argv.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
}

/**
 * A delivery that failed after the message may already have reached the pane (#89): sending it again could deliver
 * it twice. `typed`: the text is in the pane's input and only the Enter that submits it is missing.
 */
export class DeliveryUncertain extends Error {
  constructor(readonly failure: unknown, readonly typed: boolean) {
    super(failure instanceof Error ? failure.message : String(failure));
  }
}

/** Agent lifecycle as the backend reports it. `shell` = no agent in front; `done` = the terminal's program exited. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown" | "shell" | "gone";

export type PaneRef = { readonly paneId: string; readonly tabId: string; readonly workspaceId: string };

export interface TerminalBackend {
  createWorkspace(label: string, cwd: string): Promise<PaneRef>;
  createTab(label: string, cwd: string, workspaceId?: string, env?: Record<string, string>): Promise<PaneRef>;
  split(paneId: string, cwd: string, env?: Record<string, string>): Promise<PaneRef>;
  /** Launches a program in a freshly created pane. Never used for agent messages. */
  run(paneId: string, commandLine: string): Promise<void>;
  status(paneId: string): Promise<AgentStatus>;
  /**
   * Delivers one message to the agent in a pane. Returns false, having typed nothing, when no agent is in front: text
   * typed into a bare shell runs as a command (#66). Throws DeliveryUncertain when the message may already be in the
   * pane (#89); the caller must not send it again as is.
   */
  deliver(paneId: string, text: string): Promise<boolean>;
  /** Presses only the Enter that submits already typed text; false, pressing nothing, unless an agent is in front. */
  submitTyped(paneId: string): Promise<boolean>;
  /** True when an interactive shell is in front, or the lookup failed: both hold delivery. */
  shellInForeground(paneId: string): Promise<boolean>;
  /** The operator's explicit `dori send --to-shell`: types text + Enter into a pane that has no agent, else false. */
  typeIntoShell(paneId: string, text: string): Promise<boolean>;
  read(paneId: string, lines?: number): Promise<string>;
  close(paneId: string): Promise<void>;
}

const INPUT_RULE = /^─{10,}$/;
/** Lines omo prints below its input box (cwd/model line, status line); more than this and the box is not at the bottom. */
const FOOTER_MAX_LINES = 3;

/**
 * True only when an omo screen positively shows its idle input at the bottom: a bare rule, an empty `❯`
 * line, a bare rule, and no `esc to interrupt` anywhere. Anything else (a turn, a dialog, a draft in the
 * input, an unknown layout) is false, so the caller keeps queueing. An omo whose live monitors or background
 * cells are running sits at this idle input between turns (#62).
 */
export function omoScreenIdle(screen: string): boolean {
  if (screen.includes("esc to interrupt")) return false;
  const lines = screen.split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const input = lines.lastIndexOf("❯");
  if (input < 1 || input + 1 >= lines.length) return false;
  if (!INPUT_RULE.test(lines[input - 1]!) || !INPUT_RULE.test(lines[input + 1]!)) return false;
  return lines.length - 1 - (input + 1) <= FOOTER_MAX_LINES;
}

const SHELLS: ReadonlySet<string> = new Set([
  "sh", "ash", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh", "powershell", "busybox",
]);
const baseName = (value: unknown): string => String(value ?? "").replace(/^-/, "").split("/").pop()!.toLowerCase();
// A shell runs a command (not a prompt) only with an explicit command flag: -c, also inside combined short flags such
// as -lc, or PowerShell's -Command/-File/-EncodedCommand (whole words only: its other long flags contain a 'c'). Any other operand (a script path, --rcfile FILE, -o OPT) stays held.
const runsCommand = (shell: string, arg: string): boolean =>
  shell === "pwsh" || shell === "powershell"
    ? /^-(c|command|f|file|e|ec|encodedcommand)$/i.test(arg)
    : /^-[A-Za-z]*c[A-Za-z]*$/.test(arg);
// PowerShell's -NoExit (any prefix it accepts: -noe, -noex, -noexi, -noexit, one or two dashes) keeps an interactive
// prompt after the command runs, so that shell is held.
const keepsPrompt = (shell: string, arg: string): boolean => (shell === "pwsh" || shell === "powershell") && /^--?noe(x(i(t)?)?)?$/i.test(arg);

/**
 * True when the pane's foreground processes include an interactive shell, or cannot be read. An agent suspended with
 * Ctrl+Z leaves its shell in front while its old screen still looks idle (#66). A shell that runs a command flag
 * (`sh -c ...`) is an agent's child, not a prompt, and does not count; any other shell, a script runner such as
 * `bash script.sh` included, is held.
 */
export function interactiveShellInFront(processInfo: unknown): boolean {
  const procs = (processInfo as { foreground_processes?: unknown } | undefined)?.foreground_processes;
  if (!Array.isArray(procs) || procs.length === 0) return true;
  for (const proc of procs as { name?: unknown; argv?: unknown }[]) {
    let name = baseName(proc?.name);
    let args = Array.isArray(proc?.argv) ? proc.argv.map(String).slice(1) : undefined;
    if (name === "busybox" && args && args.length > 0) [name, args] = [baseName(args[0]), args.slice(1)];
    if (!SHELLS.has(name)) continue;
    if (args === undefined) return true;
    if (!args.some((a) => runsCommand(name, a)) || args.some((a) => keepsPrompt(name, a))) return true;
  }
  return false;
}

export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
