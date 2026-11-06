import { basename, join } from "node:path";
import { homedir } from "node:os";
import {
  CommandError, DeliveryUncertain, interactiveShellInFront, omoScreenIdle, shq, spawnExec,
  type AgentStatus, type Exec, type PaneRef, type TerminalBackend,
} from "./terminal.ts";

type Terminal = {
  readonly address: string;
  readonly name: string;
  readonly argv: readonly string[];
  readonly state: string;
  readonly foreground: { readonly name: string; readonly argv: readonly string[] } | null;
  readonly where: string;
  readonly space: string;
};

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("hc returned an invalid object");
  return Object.fromEntries(Object.entries(value));
}

function terminal(text: string): Terminal {
  const value = object(JSON.parse(text));
  if (typeof value["address"] !== "string" || typeof value["state"] !== "string") throw new Error("hc returned no terminal address or state");
  const front = value["foreground"] == null ? null : object(value["foreground"]);
  if (front && (typeof front["name"] !== "string" || !Array.isArray(front["argv"]) || !front["argv"].every((v: unknown) => typeof v === "string"))) {
    throw new Error("hc returned invalid foreground metadata");
  }
  const labels = value["labels"] == null ? {} : object(value["labels"]);
  return {
    address: value["address"], name: typeof value["name"] === "string" ? value["name"] : "",
    argv: Array.isArray(value["argv"]) ? value["argv"].map(String) : [], state: value["state"],
    foreground: front ? { name: String(front["name"]), argv: Array.isArray(front["argv"]) ? front["argv"].map(String) : [] } : null,
    where: typeof labels["where"] === "string" ? labels["where"] : "",
    space: typeof labels["herdr.space"] === "string" ? labels["herdr.space"] : "",
  };
}

/** Core has terminals rather than panes. `where` supplies the space / tab grouping. */
export class HerdrCore implements TerminalBackend {
  // Only freshly created shells may receive a launch command through run().
  private readonly launchShells = new Set<string>();
  private readonly spaces = new Map<string, { readonly id: string; readonly label: string }>();

  constructor(
    private readonly exec: Exec = spawnExec,
    private readonly binary: string = join(homedir(), ".local", "bin", "hc"),
    private readonly app: string = process.env["DORI_HERDR_APP"] || join(homedir(), ".local", "bin", "herdr-app"),
    private readonly pause: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  /** The app ignores the where label for tab names; name the tab holding the terminal. Never fails a launch. */
  private async nameTab(paneId: string, name: string): Promise<void> {
    try {
      // The window learns of a new terminal shortly after hc starts it.
      for (let attempt = 0; attempt < 10; attempt++) {
        if (attempt > 0) await this.pause(200);
        const tab = await this.tabOf(paneId);
        if (!tab) continue;
        const renamed = await this.exec(this.app, ["do", "tab.rename", "--id", tab.id, "--name", name]);
        if (renamed.code !== 0) throw new Error((renamed.stderr || renamed.stdout).trim() || `exit ${renamed.code}`);
        return;
      }
      throw new Error("no app tab holds the terminal");
    } catch (error) {
      process.stderr.write(`dori: could not name the app tab of ${paneId} "${name}": ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  /** The app tab holding the terminal, with every terminal in it; undefined when the window lists none. */
  private async tabOf(paneId: string): Promise<{ readonly id: string; readonly terminals: readonly string[] } | undefined> {
    const listed = await this.exec(this.app, ["ls"]);
    if (listed.code !== 0) throw new Error((listed.stderr || listed.stdout).trim() || `exit ${listed.code}`);
    const spaces = object(JSON.parse(listed.stdout))["spaces"];
    for (const space of Array.isArray(spaces) ? spaces : []) {
      const tabs = object(space)["tabs"];
      for (const tab of (Array.isArray(tabs) ? tabs : []).map(object)) {
        const terminals = (Array.isArray(tab["terminals"]) ? tab["terminals"] : []).map((t: unknown) => String(object(t)["terminal"]));
        if (!terminals.includes(paneId)) continue;
        if (typeof tab["id"] !== "string") throw new Error("herdr-app listed a tab without an id");
        return { id: tab["id"], terminals };
      }
    }
    return undefined;
  }

  private async tabListed(tabId: string): Promise<boolean> {
    const listed = await this.exec(this.app, ["ls"]);
    if (listed.code !== 0) return true;
    const spaces = object(JSON.parse(listed.stdout))["spaces"];
    return (Array.isArray(spaces) ? spaces : []).some((space) => {
      const tabs = object(space)["tabs"];
      return (Array.isArray(tabs) ? tabs : []).some((tab) => object(tab)["id"] === tabId);
    });
  }

  /**
   * Removes a finished lane's terminal (hc kill, then hc rm) and closes its app tab. hc may hand a removed address
   * to a new terminal, so only the terminal dori launched for this lane is touched: its hc name is dori-... and its
   * launch argv carries DORI_LANE=<key>. A tab that still holds another live terminal is kept.
   */
  async retire(paneId: string, laneKey: string): Promise<string> {
    const own = await this.get(paneId);
    if (own && (!own.name.startsWith("dori-") || !own.argv.includes(`DORI_LANE=${laneKey}`))) {
      return `kept: terminal ${paneId} is not the one dori started for lane ${laneKey}`;
    }
    let tab: { readonly id: string; readonly terminals: readonly string[] } | undefined;
    let tabProblem = "";
    try {
      tab = await this.tabOf(paneId);
    } catch (error) {
      tabProblem = error instanceof Error ? error.message : String(error);
    }
    const others = [];
    for (const other of tab?.terminals.filter((t) => t !== paneId) ?? []) {
      if (await this.status(other) !== "gone") others.push(other);
    }
    if (own) {
      if (own.state === "live") await this.call(["kill", paneId]);
      await this.call(["rm", paneId]);
    }
    const removed = own ? `terminal ${paneId} removed` : `terminal ${paneId} already gone`;
    if (tabProblem) return `${removed}; tab not closed: ${tabProblem}`;
    if (!tab) return `${removed}; no app tab held it`;
    if (others.length > 0) return `${removed}; tab ${tab.id} kept: it holds live ${others.join(", ")}`;
    const closed = await this.exec(this.app, ["do", "tab.close", "--id", tab.id, "--confirmed", "true"]);
    // The window drops a tab whose last terminal hc removed, so a refused close of a tab it no longer lists is done.
    if (closed.code !== 0 && await this.tabListed(tab.id)) return `${removed}; tab ${tab.id} not closed: ${(closed.stderr || closed.stdout).trim()}`;
    return `${removed}; tab ${tab.id} closed`;
  }

  private async call(argv: readonly string[]): Promise<string> {
    const result = await this.exec(this.binary, argv);
    if (result.code !== 0) throw new CommandError(basename(this.binary), argv, result);
    return result.stdout;
  }

  private async get(paneId: string): Promise<Terminal | undefined> {
    try {
      return terminal(await this.call(["get", paneId, "--json"]));
    } catch (error) {
      if (error instanceof CommandError) {
        // Match only the structured error, never argv (which may contain arbitrary text).
        const raw = error.result.stderr || error.result.stdout;
        try {
          if (object(object(JSON.parse(raw))["error"])["kind"] === "not_found") return undefined;
        } catch {
          // Non-JSON failures (including a down server) must remain errors.
        }
      }
      throw error;
    }
  }

  async createWorkspace(label: string, cwd: string): Promise<PaneRef> {
    return this.createTab("lead", cwd, label);
  }

  private async space(workspaceId: string): Promise<{ readonly id: string; readonly label: string }> {
    const cached = this.spaces.get(workspaceId);
    if (cached) return cached;
    // Every Dori terminal lands in one space: an explicit DORI_HERDR_SPACE, else the space Dori is started from.
    const preferred = await this.preferredSpace();
    if (preferred) {
      this.spaces.set(workspaceId, preferred);
      return preferred;
    }
    const list = object(JSON.parse(await this.call(["ls", "--json"])))["terminals"];
    if (!Array.isArray(list)) throw new Error("hc returned no terminal list");
    const candidates = list.map(object).filter((t) =>
      typeof t["address"] === "string" && /^t[0-9a-z]+$/.test(t["address"]) && typeof t["where"] === "string");
    const named = candidates.find((t) => String(t["where"]).split(" / ")[0] === workspaceId);
    // Core has no space-create API. Reuse an app space rather than inventing a herdr.space ID.
    const candidatesInOrder = named ? [named] : candidates;
    for (const candidate of candidatesInOrder) {
      const value = await this.get(String(candidate["address"]));
      if (!value?.space) continue;
      if (workspaceId !== "dori" && !named && value.space !== workspaceId) continue;
      const resolved = { id: value.space, label: value.where.split(" / ")[0] || workspaceId };
      this.spaces.set(workspaceId, resolved);
      this.spaces.set(resolved.id, resolved);
      return resolved;
    }
    return { id: "", label: workspaceId };
  }

  private async preferredSpace(): Promise<{ readonly id: string; readonly label: string } | undefined> {
    const id = this.env["DORI_HERDR_SPACE"];
    if (id) {
      const list = object(JSON.parse(await this.call(["ls", "--json"])))["terminals"];
      if (!Array.isArray(list)) throw new Error("hc returned no terminal list");
      for (const candidate of list.map(object)) {
        if (typeof candidate["address"] !== "string") continue;
        const value = await this.get(candidate["address"]);
        if (value?.space === id) return { id, label: value.where.split(" / ")[0] || id };
      }
      throw new Error(`no hc terminal is in DORI_HERDR_SPACE ${id}`);
    }
    const self = this.env["HC_TERMINAL_ID"];
    if (!self) return undefined;
    const value = await this.get(self);
    if (!value?.space) return undefined;
    return { id: value.space, label: value.where.split(" / ")[0] || value.space };
  }

  async createTab(label: string, cwd: string, workspaceId = "dori", env: Record<string, string> = {}): Promise<PaneRef> {
    const space = await this.space(workspaceId);
    const name = `dori-${crypto.randomUUID().slice(0, 12)}`;
    // hc's server does not inherit the caller's environment. Pass the harness configuration explicitly.
    const inherited = Object.fromEntries(Object.entries(this.env).filter(([key, value]) =>
      value !== undefined && (key.startsWith("DORI_") || key === "PATH")));
    const vars = { ...inherited, ...env, HERDR_WORKSPACE_ID: space.id || workspaceId };
    const placement = space.id ? ["--label", `herdr.space=${space.id}`] : [];
    const output = object(JSON.parse(await this.call([
      "run", "--bg", "--json", "--name", name, "--no-parent", "--outlive-parent",
      "--cwd", cwd, "--label", `where=${space.label} / dori-${label}`, ...placement,
      "--", "/usr/bin/env", ...Object.entries(vars).map(([key, value]) => `${key}=${value}`), "/bin/sh", "-i",
    ])));
    const paneId = output["address"];
    if (typeof paneId !== "string" || !/^t[0-9a-z]+$/.test(paneId)) throw new Error("hc returned no local terminal address");
    this.launchShells.add(paneId);
    await this.nameTab(paneId, label);
    return { paneId, tabId: paneId, workspaceId: space.id || workspaceId };
  }

  async split(paneId: string, cwd: string, env: Record<string, string> = {}): Promise<PaneRef> {
    const parent = await this.get(paneId);
    if (!parent) throw new Error(`hc terminal ${paneId} is gone`);
    const [space, tab] = parent.where.split(" / ");
    return this.createTab(tab === "dori-duty" ? "duty-loop" : "hourly-loop", cwd, parent.space || space || "dori", env);
  }

  async run(paneId: string, commandLine: string): Promise<void> {
    if (!this.launchShells.has(paneId)) throw new Error(`hc terminal ${paneId} is not a fresh launch shell`);
    // This is an explicit program launch, never an agent message. exec leaves no shell prompt behind on exit.
    await this.call(["send", paneId, `exec /bin/sh -c ${shq(commandLine)}`]);
    this.launchShells.delete(paneId);
  }

  async status(paneId: string): Promise<AgentStatus> {
    const value = await this.get(paneId);
    // A finished terminal's program has ended: nothing can reach it any more, so it is as gone as a missing one.
    if (!value || value.state !== "live") return "gone";
    if (interactiveShellInFront({ foreground_processes: value.foreground ? [value.foreground] : [] })) return "shell";
    let screen: string;
    try {
      screen = await this.read(paneId, 0);
    } catch (error) {
      // An unreadable screen is doubt: the caller keeps the message queued.
      if (!(error instanceof Error)) throw error;
      return "unknown";
    }
    // Prefer the active input region to old output above it.
    if (omoScreenIdle(screen)) return "idle";
    const bottom = screen.split("\n").slice(-30).join("\n");
    if (/esc to interrupt|^\s*(?:[^\w\s]\s*)?Working\b/im.test(bottom)) return "working";
    if (/\b(?:question|permission required|waiting for (?:your|user))\b|(?:allow|proceed|continue|confirm)[^\n]*\?|enter to (?:confirm|select)|esc to cancel|\[y\/n\]/i.test(bottom)) return "blocked";
    return "unknown";
  }

  async shellInForeground(paneId: string): Promise<boolean> {
    try {
      const value = await this.get(paneId);
      return !value || value.state !== "live" ||
        interactiveShellInFront({ foreground_processes: value.foreground ? [value.foreground] : [] });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      process.stderr.write(`dori: hc foreground lookup failed for ${paneId}; holding delivery\n`);
      return true;
    }
  }

  async deliver(paneId: string, text: string): Promise<boolean> {
    const state = await this.status(paneId);
    if ((state !== "idle" && state !== "done") || await this.shellInForeground(paneId)) return false;
    try {
      // hc send owns bracketed paste and Enter; a failure can be ambiguous, so never resend it.
      await this.call(["send", paneId, text]);
    } catch (error) {
      throw new DeliveryUncertain(error, false);
    }
    return true;
  }

  async submitTyped(paneId: string): Promise<boolean> {
    if (await this.shellInForeground(paneId)) return false;
    try {
      await this.call(["keys", paneId, "enter"]);
    } catch (error) {
      throw new DeliveryUncertain(error, true);
    }
    return true;
  }

  async typeIntoShell(paneId: string, text: string): Promise<boolean> {
    if (await this.status(paneId) !== "shell") return false;
    const value = await this.get(paneId);
    if (!value || value.state !== "live" || !value.foreground ||
      !interactiveShellInFront({ foreground_processes: [value.foreground] })) return false;
    await this.call(["send", paneId, text]);
    return true;
  }

  async read(paneId: string, lines = 80): Promise<string> {
    const value = object(JSON.parse(await this.call(["read", paneId, "--json", "--lines", String(lines)])));
    if (typeof value["text"] !== "string") throw new Error("hc returned no screen text");
    return value["text"].replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  }

  async close(paneId: string): Promise<void> {
    await this.call(["kill", paneId]);
    this.launchShells.delete(paneId);
  }
}
