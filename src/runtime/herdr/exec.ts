// The herdr CLI behind one injectable `Exec`: every call carries `--session` when one is named, so tests swap herdr for
// a recorder and the e2e test points it at an isolated session.
import { type Exec, spawnExec, ToolError } from "../exec.ts";

/** A herdr call that exited non-zero (#89 code matches herdr's own output on it, never its message). */
export const HerdrError = ToolError;
export type HerdrError = ToolError;
export { ToolError };

export class HerdrCli {
  constructor(
    private readonly exec: Exec = spawnExec,
    private readonly session: string | undefined = process.env["DORI_HERDR_SESSION"],
  ) {}

  async call(argv: readonly string[]): Promise<Record<string, unknown>> {
    const full = this.session ? ["--session", this.session, ...argv] : [...argv];
    const res = await this.exec("herdr", full);
    if (res.code !== 0) throw new ToolError(full, res, "herdr");
    const text = res.stdout.trim();
    if (!text.startsWith("{")) return {};
    const parsed = JSON.parse(text) as { result?: Record<string, unknown> };
    return parsed.result ?? {};
  }

  /** `pane read` returns the screen as plain text, not JSON. */
  async read(paneId: string, lines: number, source: "recent" | "recent-unwrapped" = "recent"): Promise<string> {
    const full = this.session ? ["--session", this.session] : [];
    const res = await this.exec("herdr", [
      ...full,
      "pane",
      "read",
      paneId,
      "--lines",
      String(lines),
      "--source",
      source,
    ]);
    if (res.code !== 0) throw new ToolError(["pane", "read", paneId], res, "herdr");
    return res.stdout;
  }
}

/** herdr's own reason for a failed call; never the error message, which carries argv and so the delivered text. */
export const reasonOf = (e: unknown): string =>
  e instanceof ToolError ? (e.result.stderr || e.result.stdout).trim() : String(e);
