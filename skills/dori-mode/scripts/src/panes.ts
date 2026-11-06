import type { Clock, Runner } from "./run.ts";

export type Pane = {
  /** The hc terminal address (e.g. t1w). A lane's pane and tab are both this address. */
  readonly pane_id: string;
  /** The space segment of hc's `where` ("<space name> / <tab>"). */
  readonly workspace_id: string;
  readonly tab_id?: string;
  readonly agent?: string;
  /** Only "done" (the terminal finished) comes from the list; call agentStatus for a running terminal. */
  readonly agent_status?: string;
  readonly title?: string;
  readonly cwd?: string;
};

export class UnsafeTextError extends Error {}

type HcTerminal = { address: string; name?: string | null; cwd?: string | null; where?: string | null; agent?: string | null; state?: string | null };

export const listPanes = async (run: Runner): Promise<Pane[]> => {
  const r = await run(["hc", "ls", "--json"]);
  if (r.code !== 0) throw new Error(`hc ls failed: ${r.err || r.out}`);
  return ((JSON.parse(r.out) as { terminals?: HcTerminal[] }).terminals ?? []).map((t) => ({
    pane_id: t.address,
    workspace_id: (t.where ?? "").split(" / ")[0] ?? "",
    tab_id: t.address,
    ...(t.agent ? { agent: t.agent } : {}),
    ...(t.state === "finished" ? { agent_status: "done" } : {}),
    ...(t.name ? { title: t.name } : {}),
    ...(t.cwd ? { cwd: t.cwd } : {}),
  }));
};

/** The last `lines` lines of the terminal, or only the visible screen when lines is 0 or omitted. */
export const readScreen = async (run: Runner, pane: string, lines?: number): Promise<string> =>
  (await run(["hc", "read", pane, "--lines", String(lines ?? 0)])).out;

export type Foreground = { readonly name?: string; readonly argv?: readonly string[]; readonly pid?: number; readonly cwd?: string };
export type TerminalInfo = {
  readonly address: string;
  readonly state: "live" | "finished" | string;
  readonly pid?: number;
  readonly foreground: Foreground | null;
  readonly labels: Readonly<Record<string, string>>;
};

/** `hc get <t> --json`; undefined for an unknown terminal (exit 3, not_found). Any other failure throws. */
export const terminalInfo = async (run: Runner, pane: string): Promise<TerminalInfo | undefined> => {
  const r = await run(["hc", "get", pane, "--json"]);
  if (r.code === 3) return undefined;
  if (r.code !== 0) throw new Error(`hc get failed: ${r.err || r.out}`);
  const v = JSON.parse(r.out) as Partial<TerminalInfo>;
  return { address: v.address ?? pane, state: v.state ?? "live", ...(typeof v.pid === "number" ? { pid: v.pid } : {}), foreground: v.foreground ?? null, labels: v.labels ?? {} };
};

/**
 * The herdr.space lanes open in, with its name for the where label: config.laneWorkspace, else the space of the terminal
 * HC_TERMINAL_ID names. An empty id means no space is known.
 */
export const laneSpace = async (run: Runner, laneWorkspace: string, self = process.env.HC_TERMINAL_ID): Promise<{ readonly id: string; readonly name: string }> => {
  const info = self ? await terminalInfo(run, self) : undefined;
  const ownId = info?.labels["herdr.space"] ?? "";
  const ownName = (info?.labels["where"] ?? "").split(" / ")[0] ?? "";
  const id = laneWorkspace || ownId;
  return { id, name: (id === ownId && ownName) || id };
};

const TAB_LOOKUPS = 10;

/**
 * Best effort: names the herdr-app tab holding the terminal. The window lists a new terminal shortly after hc starts
 * it, so a missing tab is looked up again, 200 ms apart. A failure is logged to stderr and returns false.
 */
export const nameTab = async (run: Runner, clock: Clock, address: string, name: string): Promise<boolean> => {
  try {
    type Tab = { id?: string; terminals?: { terminal?: string }[] };
    let tab: Tab | undefined;
    for (let attempt = 0; attempt < TAB_LOOKUPS && !tab; attempt++) {
      if (attempt > 0) await clock.sleep(200);
      const ls = await run(["herdr-app", "ls"]);
      if (ls.code !== 0) throw new Error(ls.err || ls.out);
      const spaces = (JSON.parse(ls.out) as { spaces?: { tabs?: Tab[] }[] }).spaces ?? [];
      tab = spaces.flatMap((s) => s.tabs ?? []).find((t) => (t.terminals ?? []).some((x) => x.terminal === address));
    }
    if (!tab?.id) throw new Error(`no tab holds ${address}`);
    const r = await run(["herdr-app", "do", "tab.rename", "--id", tab.id, "--name", name]);
    if (r.code !== 0) throw new Error(r.err || r.out);
    return true;
  } catch (e) {
    console.error(`tab rename ${address}: herdr-app failed (${e instanceof Error ? e.message : String(e)})`);
    return false;
  }
};

/** Statuses of a terminal whose agent is running (or finished, "done"). A bare shell or an unknown screen has none. */
export const ALIVE_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done"]);

const INPUT_RULE = /^─{10,}$/;
const FOOTER_MAX_LINES = 3;

/**
 * True only when an omo screen positively shows its idle input at the bottom: a bare rule, an empty `❯` line, a bare
 * rule, at most FOOTER_MAX_LINES below it, and no `esc to interrupt` anywhere. Same rule as dori's src/herdr.ts.
 */
export const omoScreenIdle = (screen: string): boolean => {
  if (screen.includes("esc to interrupt")) return false;
  const lines = screen.split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const input = lines.lastIndexOf("❯");
  if (input < 1 || input + 1 >= lines.length) return false;
  if (!INPUT_RULE.test(lines[input - 1]!) || !INPUT_RULE.test(lines[input + 1]!)) return false;
  return lines.length - 1 - (input + 1) <= FOOTER_MAX_LINES;
};

/** Classifies a visible screen: "idle", "working", "blocked", or undefined when nothing is recognised. */
export const screenStatus = (screen: string): string | undefined => {
  if (omoScreenIdle(screen)) return "idle";
  const bottom = screen.split("\n").slice(-30).join("\n");
  if (/esc to interrupt|^\s*(?:[^\w\s]\s*)?Working\b/im.test(bottom)) return "working";
  if (/\b(?:question|permission required|waiting for (?:your|user))\b|(?:allow|proceed|continue|confirm)[^\n]*\?|enter to (?:confirm|select)|esc to cancel|\[y\/n\]/i.test(bottom)) return "blocked";
  return undefined;
};

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

/** True when the foreground process is an interactive shell, or there is none. Same rule as dori's src/herdr.ts. */
export const interactiveShellInFront = (fg: Foreground | null): boolean => {
  const procs = fg ? [fg] : [];
  if (procs.length === 0) return true;
  for (const proc of procs as { name?: unknown; argv?: unknown }[]) {
    let name = baseName(proc?.name);
    let args = Array.isArray(proc?.argv) ? proc.argv.map(String).slice(1) : undefined;
    if (name === "busybox" && args && args.length > 0) [name, args] = [baseName(args[0]), args.slice(1)];
    if (!SHELLS.has(name)) continue;
    if (args === undefined) return true;
    if (!args.some((a) => runsCommand(name, a)) || args.some((a) => keepsPrompt(name, a))) return true;
  }
  return false;
};

/**
 * hc reports no status for omo agents, so it is derived as in dori's src/herdr-core.ts: an unknown terminal has none,
 * a finished one is "done", a shell in the foreground (an agent suspended with Ctrl+Z, #66) has none, and otherwise
 * the visible screen is classified by screenStatus.
 */
export const agentStatus = async (run: Runner, pane: string): Promise<string | undefined> => {
  const info = await terminalInfo(run, pane);
  if (!info) return undefined;
  if (info.state !== "live") return "done";
  if (interactiveShellInFront(info.foreground)) return undefined;
  return screenStatus(await readScreen(run, pane, 0));
};

/** Like agentStatus, but a failed lookup comes back as its error text instead of being swallowed. */
export const statusLookup = async (run: Runner, pane: string): Promise<{ readonly status?: string; readonly error?: string }> => {
  try {
    return { status: await agentStatus(run, pane) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * True when `hc get` shows an interactive shell in the terminal's foreground, no foreground at all, or cannot be read.
 * A shell running a command flag (`sh -c ...`) is the agent's child and does not count; any other shell,
 * `bash script.sh` included, is held.
 */
export const shellInFront = async (run: Runner, pane: string): Promise<boolean> => {
  try {
    const info = await terminalInfo(run, pane);
    return !info || info.state !== "live" || interactiveShellInFront(info.foreground);
  } catch (e) {
    console.error(`sendVerified ${pane}: hc get failed (${e instanceof Error ? e.message : String(e)}); holding the send`);
    return true;
  }
};

export type Delivery = "delivered" | "unconfirmed" | "failed";

/**
 * Sends the text with one `hc send`, which pastes it and presses Enter. Delivery is confirmed only by a state change:
 * the derived status moving to "working" from something else. A terminal that was already working cannot show that
 * change, so its send comes back "unconfirmed" and the caller decides. Nothing is ever sent twice.
 */
export const sendVerified = async (run: Runner, clock: Clock, pane: string, text: string): Promise<Delivery> => {
  if (/`|\$\(/.test(text)) throw new UnsafeTextError("refusing to send text containing a backtick or $(");
  const before = await statusLookup(run, pane);
  if (before.error) console.error(`sendVerified ${pane}: status lookup failed before send: ${before.error}`);
  // No running agent means a bare shell, where typed text runs as a command (#66). A failed lookup is doubt: refuse.
  if (before.status === undefined || !ALIVE_STATUSES.has(before.status)) return "failed";
  if (await shellInFront(run, pane)) return "failed";
  if ((await run(["hc", "send", pane, text])).code !== 0) return "failed";
  if (before.status === "working") return "unconfirmed";
  for (let attempt = 0; attempt < 6; attempt++) {
    await clock.sleep(700);
    const after = await statusLookup(run, pane);
    if (after.error) console.error(`sendVerified ${pane}: status lookup failed: ${after.error}`);
    if (after.status === "working") return "delivered";
  }
  return "unconfirmed";
};
