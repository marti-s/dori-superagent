// A recorder standing in for the `hc` binary: argv in, the JSON `hc --json` prints out, over a terminals map.
import type { Exec, ExecResult } from "../src/runtime/exec.ts";

export type FakeStatus = { state: string; app?: string } | null;
export type FakeTerminal = {
  state: "live" | "finished";
  pid?: number;
  title?: string;
  cwd?: string;
  status: FakeStatus;
  reported: boolean;
  turn: number;
  foreground: { name: string; argv: string[]; pid: number } | null;
  name?: string;
  labels: Record<string, string>;
  screen?: string;
  /** Terminal width, as `hc get` reports it. */
  cols?: number;
};

export type FakeKnobs = {
  /** Every `send` answers this error kind (exit code from hc's table) and types nothing. */
  sendError?: string;
  /** Every `send` exits non-zero with no JSON at all (a transport failure). */
  sendGarbled?: boolean;
  /** Every `send` throws inside the runner (the process could not be read back). */
  sendThrows?: boolean;
  started?: boolean | null;
  /** How many `rm` calls answer `live` after a kill. */
  liveAfterKill?: number;
  /** The next `run` answers `name_taken`. */
  nameTaken?: boolean;
  /** `get` answers this error kind for every terminal. */
  getError?: string;
  /** `read` answers this error kind for every terminal. */
  readError?: string;
};

const EXIT: Readonly<Record<string, number>> = {
  usage: 2,
  not_found: 3,
  machine_unknown: 4,
  unavailable: 5,
  invalid_params: 6,
  needs_target: 7,
  config: 8,
  blocked: 9,
  status_mismatch: 10,
  finished: 11,
  live: 1,
  name_taken: 1,
};

const ok = (value: unknown): ExecResult => ({ code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" });
const fail = (kind: string, message: string): ExecResult => ({
  code: EXIT[kind] ?? 1,
  stdout: "",
  stderr: `${JSON.stringify({ error: { hint: `hint for ${kind}`, kind, message } })}\n`,
});

export function terminal(over: Partial<FakeTerminal> = {}): FakeTerminal {
  return {
    state: "live",
    pid: 900,
    title: "omo lane",
    cwd: "/w",
    status: { state: "idle", app: "omo" },
    reported: true,
    turn: 3,
    foreground: { name: "omo", argv: ["omo"], pid: 4242 },
    labels: {},
    ...over,
  };
}

export class FakeHc {
  readonly calls: string[][] = [];
  readonly sent: { id: string; text: string }[] = [];
  readonly terminals = new Map<string, FakeTerminal>();
  knobs: FakeKnobs = {};
  private next = 1;

  constructor(initial: Record<string, FakeTerminal> = {}) {
    for (const [id, t] of Object.entries(initial)) this.terminals.set(id, t);
    this.next = this.terminals.size + 1;
  }

  readonly exec: Exec = async (cmd, argv) => {
    if (cmd !== "hc" || argv[0] !== "--json") throw new Error(`unexpected call ${cmd} ${argv.join(" ")}`);
    const args = argv.slice(1);
    this.calls.push(args);
    const [verb, id] = args;
    if (verb === "run") return this.run(args);
    if (verb === "ls") return this.ls(args);
    const t = id === undefined ? undefined : this.terminals.get(id);
    if (verb === "get" && this.knobs.getError !== undefined) return fail(this.knobs.getError, "get refused");
    if (verb === "read" && this.knobs.readError !== undefined) return fail(this.knobs.readError, "read refused");
    if (t === undefined || id === undefined) return fail("not_found", `no terminal "${id ?? ""}"`);
    switch (verb) {
      case "get":
        return ok({ address: id, ...t });
      case "read":
        return ok({ text: t.screen ?? "", complete: true, how: "screen" });
      case "send":
        return this.send(id, t, args);
      case "keys":
        return t.state === "finished"
          ? fail("finished", `${id} has finished`)
          : ok({ status: t.status?.state ?? null, turn: t.turn });
      case "kill":
        t.state = "finished";
        return ok({ address: id, ...t });
      case "rm":
        return this.rm(id, t);
      default:
        return fail("usage", `unknown verb ${verb ?? ""}`);
    }
  };

  private run(args: string[]): ExecResult {
    if (this.knobs.nameTaken && args.includes("--name")) {
      this.knobs.nameTaken = false;
      return fail("name_taken", "that name is taken");
    }
    const labels: Record<string, string> = {};
    args.forEach((a, i) => {
      const v = args[i + 1];
      if (a === "--label" && v !== undefined) labels[v.split("=")[0] ?? ""] = v.split("=").slice(1).join("=");
    });
    const nameAt = args.indexOf("--name");
    const name = nameAt >= 0 ? args[nameAt + 1] : undefined;
    const id = `t${this.next++}`;
    this.terminals.set(
      id,
      terminal({ labels, status: null, reported: false, turn: 0, ...(name === undefined ? {} : { name }) }),
    );
    return ok({ address: id, state: "live", labels });
  }

  private ls(args: string[]): ExecResult {
    const want = args.flatMap((a, i) => (a === "--label" && args[i + 1] !== undefined ? [args[i + 1] ?? ""] : []));
    const rows = [...this.terminals.entries()]
      .filter(([, t]) => t.state === "live" || args.includes("--all"))
      .filter(([, t]) =>
        want.every((kv) => `${kv.split("=")[0]}=${t.labels[kv.split("=")[0] ?? ""] ?? "\u0000"}` === kv),
      )
      .map(([address, t]) => ({
        address,
        agent: t.foreground?.name,
        cwd: "/w",
        state: t.state,
        turn: t.turn,
        ...(t.name === undefined ? {} : { name: t.name }),
        ...(t.status === null ? {} : { status: t.status.state }),
      }));
    return ok({ hidden_finished: 0, machines: [], terminals: rows });
  }

  private send(id: string, t: FakeTerminal, args: string[]): ExecResult {
    const k = this.knobs;
    if (k.sendThrows) throw new Error("broken pipe");
    if (k.sendGarbled) return { code: 1, stdout: "", stderr: "connection reset\n" };
    if (k.sendError !== undefined) return fail(k.sendError, `send refused (${k.sendError})`);
    if (t.state === "finished") return fail("finished", `${id} has finished`);
    if (t.status?.state === "blocked" && !args.includes("--force")) return fail("blocked", `${id} is blocked`);
    const ifAt = args.indexOf("--if");
    const want = ifAt >= 0 ? args[ifAt + 1] : undefined;
    if (want !== undefined && t.status?.state !== want)
      return fail("status_mismatch", `${id} is ${t.status?.state ?? "unreported"}`);
    const text = args[args.length - 1] ?? "";
    this.sent.push({ id, text });
    t.turn += 1;
    return ok({ status: t.status?.state ?? null, turn: t.turn, started: k.started === undefined ? true : k.started });
  }

  private rm(id: string, t: FakeTerminal): ExecResult {
    const left = this.knobs.liveAfterKill ?? 0;
    if (t.state === "live" || left > 0) {
      if (left > 0) this.knobs.liveAfterKill = left - 1;
      return fail("live", `${id} is still running`);
    }
    this.terminals.delete(id);
    return ok({ removed: id });
  }
}
