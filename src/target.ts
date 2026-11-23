import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { parseRef, type SessionRef } from "./runtime/types.ts";
import { RESERVED_KEYS, type Role } from "./store-types.ts";

const ROLES_ALL: readonly Role[] = RESERVED_KEYS;
const isRole = (target: string): target is Role => (ROLES_ALL as readonly string[]).includes(target);

/**
 * Where a send goes, in this order: a prefixed ref (`hc:t7`), a role, an open lane key, a bare hc terminal address
 * (`t7`). A lane named `t7` is that lane; the hc terminal t7 is then `hc:t7`.
 */
export function resolveTarget(d: Deps, target: string): SessionRef {
  if (target.startsWith("hc:")) {
    const ref = parseRef(target);
    if (ref) return ref;
    throw new Refusal(`${target} is not a session ref (hc:t7)`);
  }
  if (isRole(target)) {
    const ref = d.store.roles()[target];
    if (!ref) throw new Refusal(`no ${target} session registered (dori role ${target} <ref>)`);
    return ref;
  }
  const lane = d.store.lane(target);
  if (lane && lane.status !== "done") return lane.sessionRef;
  const bare = parseRef(target);
  if (bare) return bare;
  throw new Refusal(`unknown target ${target}: not an hc terminal address, role or open lane`);
}
