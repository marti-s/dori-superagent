// The `hc` branch of the fake Runner: argv in, what `hc --json` prints out, over a terminals map (shape of the root's
// test/hc-fake.ts, folded into the skill's Runner).
import type { Ran } from "../src/run.ts";

export type HcTerm = {
  state: "live" | "finished";
  status: { state: string; app?: string } | null;
  foreground: { name: string; argv: string[]; pid: number } | null;
  pid?: number;
  title?: string;
  cwd?: string;
  name?: string;
  labels: Record<string, string>;
  screen?: string;
  /** Terminal width, as `hc get` reports it. */
  cols?: number;
  turn: number;
};

export const hcTerm = (over: Partial<HcTerm> = {}): HcTerm => ({
  state: "live",
  status: { state: "idle", app: "omo" },
  foreground: { name: "omo", argv: ["omo"], pid: 4242 },
  pid: 900,
  title: "omo lane",
  cwd: "/repo",
  labels: {},
  turn: 3,
  ...over,
});

export type HcWorld = { terminals: Record<string, HcTerm>; onEnterStatus?: string };

const EXIT: Readonly<Record<string, number>> = { not_found: 3, blocked: 9, status_mismatch: 10, finished: 11, live: 1 };
const ok = (value: unknown): Ran => ({ code: 0, out: JSON.stringify(value), err: "" });
const fail = (kind: string, message: string): Ran => ({
  code: EXIT[kind] ?? 1,
  out: "",
  err: JSON.stringify({ error: { kind, message, hint: `hint for ${kind}` } }),
});
const flagValues = (args: readonly string[], flag: string): string[] =>
  args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1] ?? ""] : []));

export const hcAnswer = (w: HcWorld, argv: readonly string[]): Ran => {
  if (argv[1] !== "--json") return fail("usage", "the skill always calls hc --json");
  const args = argv.slice(2);
  const [verb, id = ""] = args;
  if (verb === "run") {
    const labels = Object.fromEntries(flagValues(args, "--label").map((kv) => [kv.split("=")[0], kv.split("=")[1]]));
    const address = `t${Object.keys(w.terminals).length + 1}`;
    const shell = { name: "zsh", argv: ["zsh"], pid: 950 };
    w.terminals[address] = hcTerm({ labels, status: null, foreground: shell, turn: 0 });
    return ok({ address, state: "live", labels });
  }
  if (verb === "ls") {
    const want = flagValues(args, "--label");
    const rows = Object.entries(w.terminals)
      .filter(
        ([, t]) =>
          t.state === "live" && want.every((kv) => `${kv.split("=")[0]}=${t.labels[kv.split("=")[0] ?? ""]}` === kv),
      )
      .map(([address, t]) => ({
        address,
        agent: t.foreground?.name,
        cwd: t.cwd,
        state: t.state,
        ...(t.status ? { status: t.status.state } : {}),
      }));
    return ok({ terminals: rows });
  }
  const t = w.terminals[id];
  if (!t) return fail("not_found", `no terminal "${id}"`);
  if (verb === "get") return ok({ address: id, ...t });
  if (verb === "read") return ok({ text: t.screen ?? "" });
  if (verb === "keys") return ok({ status: t.status?.state ?? null, turn: t.turn });
  if (verb === "kill") return ok({ address: id, ...Object.assign(t, { state: "finished" }) });
  if (verb === "rm") return delete w.terminals[id] ? ok({ removed: id }) : fail("not_found", id);
  if (verb !== "send") return fail("usage", `unknown verb ${verb}`);
  if (t.state === "finished") return fail("finished", `${id} has finished`);
  if (t.status?.state === "blocked" && !args.includes("--force")) return fail("blocked", `${id} is blocked`);
  const [want] = flagValues(args, "--if");
  if (want !== undefined && t.status?.state !== want) return fail("status_mismatch", `${id} is ${t.status?.state}`);
  t.turn += 1;
  if (t.status && w.onEnterStatus) t.status = { ...t.status, state: w.onEnterStatus };
  return ok({ status: t.status?.state ?? null, turn: t.turn, started: true });
};
