// Where a new terminal lands in the Herdr app: hc has no space-create call, so Dori joins a space that exists.
import type { Exec } from "../exec.ts";
import { hcCall, isKind } from "./exec.ts";

/** A Herdr app space: its `herdr.space` id and the name the window shows (the first part of a terminal's `where`). */
export type Space = { readonly id: string; readonly name: string };

const rec = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const nameIn = (where: unknown): string | undefined => str(str(where)?.split(" / ")[0]);

/**
 * The space every Dori terminal of this process joins: `DORI_HERDR_SPACE` (a `herdr.space` id, refused when no
 * terminal is in it), else the space of the terminal Dori runs in (`HC_TERMINAL_ID`). Undefined when neither names
 * one: the terminal is then started with no placement, outside the window.
 */
export async function placement(
  exec: Exec,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Space | undefined> {
  const wanted = str(env["DORI_HERDR_SPACE"]);
  if (wanted !== undefined) {
    const listed = await hcCall(exec, ["ls", "--label", `herdr.space=${wanted}`]);
    const first = Array.isArray(listed["terminals"]) ? listed["terminals"][0] : undefined;
    if (first === undefined) throw new Error(`no hc terminal is in DORI_HERDR_SPACE ${wanted}`);
    return { id: wanted, name: nameIn(rec(first)["where"]) ?? wanted };
  }
  const self = str(env["HC_TERMINAL_ID"]);
  if (self === undefined) return undefined;
  let labels: Record<string, unknown>;
  try {
    labels = rec((await hcCall(exec, ["get", self]))["labels"]);
  } catch (e) {
    if (isKind(e, "not_found")) return undefined;
    throw e;
  }
  const id = str(labels["herdr.space"]);
  return id === undefined ? undefined : { id, name: nameIn(labels["where"]) ?? id };
}
