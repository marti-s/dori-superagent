import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { World, sref } from "./fake.ts";

export function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("t1", "idle");
  d.store.setRole("lead", sref("t1"));
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  return { w, d, lead, brief };
}
