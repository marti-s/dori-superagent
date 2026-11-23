import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { backlogAdd } from "../src/backlog.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { loopTick } from "../src/loop.ts";
import { World, sref } from "./fake.ts";

export function setup(opts: { lead?: boolean; exec?: (inner: Exec) => Exec } = {}) {
  const w = new World();
  if (opts.exec) w.exec = opts.exec(w.exec);
  const d = w.deps();
  const lead = w.addPane("t1", "idle");
  if (opts.lead !== false) d.store.setRole("lead", sref("t1"));
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Do the thing.");
  const add = (id: string, o: Parameters<typeof backlogAdd>[3] = {}) =>
    backlogAdd(d, id, brief, { cwd: d.store.root, ...o });
  const tick = (o: Parameters<typeof loopTick>[1] = {}) => loopTick(d, { force: true, ...o });
  const destructive = () => w.calls.filter((c) => c.argv.join(" ").match(/--json (kill|rm) |pr merge|push/));
  return { w, d, lead, brief, add, tick, destructive };
}
