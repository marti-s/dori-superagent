// One injectable process runner shared by every runtime adapter, so tests replace the runtime binary with a recorder
// and end-to-end tests point it at an isolated session.

/** `timedOut`: the command was killed at its `timeoutMs`; `stdout` holds what it printed until then. */
export type ExecResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
};
/** `onSpawn` gets the running process, so a caller that gives up on it can kill it. `timeoutMs` kills it at a deadline. */
export type ExecOptions = { readonly onSpawn?: (proc: { kill(): void }) => void; readonly timeoutMs?: number };
export type Exec = (cmd: string, argv: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

export const spawnExec: Exec = async (cmd, argv, options = {}) => {
  // A command with a deadline gets its own process group, so the kill also reaches its children: one left holding
  // stdout open would keep the read below waiting.
  const deadline = options.timeoutMs;
  const proc = Bun.spawn([cmd, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: deadline !== undefined,
  });
  options.onSpawn?.(proc);
  let timedOut = false;
  const timer =
    deadline === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {
            proc.kill("SIGKILL");
          }
        }, deadline);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, ...(timedOut ? { timedOut } : {}) };
  } finally {
    clearTimeout(timer);
  }
};

/** A runtime CLI call that exited non-zero; the message carries the tool, its argv and the tool's own reason. */
export class ToolError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly result: ExecResult,
    tool: string,
  ) {
    super(`${tool} ${argv.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
}
