import type { Exec } from "../src/herdr.ts";

export const idleScreen = "────────────────────\n❯\n────────────────────\nmodel";

export type CoreTerminal = {
  state: string;
  foreground: { name: string; argv: string[] } | null;
  labels: Record<string, string>;
  screen: string;
  received: string[];
  commands: string[];
  env: string[];
  cwd: string;
  name: string;
};

/** The hc wire contract, including its combined paste-and-submit send operation. */
export class FakeCore {
  readonly terminals = new Map<string, CoreTerminal>();
  readonly calls: (readonly string[])[] = [];
  fail = "";
  beforeGet: (() => void) | undefined;

  add(id = "t1"): CoreTerminal {
    const value: CoreTerminal = {
      state: "live", foreground: { name: "bun", argv: ["bun", "omo.js"] },
      labels: { where: "dori / duty" }, screen: idleScreen,
      received: [], commands: [], env: [], cwd: "", name: "",
    };
    this.terminals.set(id, value);
    return value;
  }

  exec: Exec = async (_binary, argv) => {
    this.calls.push(argv);
    const [verb, id] = argv;
    const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
    if (verb === this.fail) return { code: 1, stdout: "", stderr: "connection lost" };
    if (verb === "ls") return ok({ terminals: [...this.terminals].map(([address, value]) => ({
      address, where: value.labels["where"],
    })) });
    if (verb === "run") {
      const value = this.add(`t${this.terminals.size + 1}`);
      const option = (key: string) => argv[argv.indexOf(key) + 1] ?? "";
      if (!argv.includes("--bg") || !argv.includes("--no-parent") || !argv.includes("--outlive-parent")) {
        return { code: 1, stdout: "", stderr: "unsafe launch" };
      }
      value.name = option("--name");
      value.cwd = option("--cwd");
      value.labels = {};
      argv.forEach((arg, index) => {
        if (arg !== "--label") return;
        const pair = argv[index + 1] ?? "";
        const equals = pair.indexOf("=");
        value.labels[pair.slice(0, equals)] = pair.slice(equals + 1);
      });
      value.env = argv.slice(argv.indexOf("/usr/bin/env") + 1, -2);
      value.foreground = { name: "sh", argv: ["/bin/sh", "-i"] };
      return ok({ address: `t${this.terminals.size}`, state: "live" });
    }
    if (verb === "get") this.beforeGet?.();
    const value = id ? this.terminals.get(id) : undefined;
    if (!value) return { code: 3, stdout: JSON.stringify({ error: { kind: "not_found", message: "no terminal" } }), stderr: "" };
    switch (verb) {
      case "get":
        return ok({ address: id, state: value.state, foreground: value.foreground, labels: value.labels });
      case "read":
        return ok({ text: value.screen, complete: true, how: "screen" });
      case "send": {
        const text = argv[2] ?? "";
        if (text.startsWith("exec /bin/sh -c ")) {
          value.commands.push(text);
          value.foreground = { name: "bun", argv: ["bun", "omo.js"] };
        } else value.received.push(text);
        return ok({});
      }
      case "keys":
        value.received.push("<enter>");
        return ok({});
      case "kill":
        value.state = "exited";
        return ok({});
      default:
        throw new Error(`unhandled hc command ${argv.join(" ")}`);
    }
  };
}
