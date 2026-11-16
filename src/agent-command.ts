import { Refusal } from "./refusal.ts";

/** Split DORI_AGENT_CMD into literal argv: quotes and escapes, without shell expansion or execution. */
export function agentCommandArgv(raw: string): readonly [string, ...string[]] {
  // A complete executable name or path wins, including an unquoted path containing spaces.
  try {
    if (Bun.which(raw) !== null) return [raw];
  } catch (error) {
    // Bun exposes this native filename limit as a plain Error without a code; argv may still be valid.
    if (!(error instanceof Error) || error.name !== "Error" || error.message !== "bin path is too long") throw error;
  }
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charAt(i);
    switch (quote) {
      case "'":
        if (char === "'") quote = undefined;
        else word += char;
        break;
      case '"':
        if (char === '"') quote = undefined;
        else if (char === "\\" && /[$`"\\\n]/.test(raw.charAt(i + 1))) {
          const next = raw.charAt(++i);
          if (next !== "\n") word += next;
        } else word += char;
        break;
      case undefined:
        if (/\s/.test(char)) {
          if (started) words.push(word);
          word = "";
          started = false;
        } else if (char === "'" || char === '"') {
          quote = char;
          started = true;
        } else if (char === "\\") {
          if (i + 1 === raw.length) throw new Refusal("DORI_AGENT_CMD ends with an escape");
          const next = raw.charAt(++i);
          if (next !== "\n") {
            word += next;
            started = true;
          }
        } else {
          word += char;
          started = true;
        }
        break;
      default: {
        const unreachable: never = quote;
        return unreachable;
      }
    }
  }
  if (quote !== undefined) throw new Refusal("DORI_AGENT_CMD has an unclosed quote");
  if (started) words.push(word);
  const [executable, ...args] = words;
  if (!executable) throw new Refusal("DORI_AGENT_CMD must contain a nonempty executable");
  return [executable, ...args];
}
