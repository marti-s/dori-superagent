import { describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import { Refusal } from "../src/refusal.ts";
import { send } from "../src/inbox.ts";
import type { AgentStatus } from "../src/runtime/types.ts";
import { World, sref } from "./fake.ts";

/** Terminal t7 in the given state (absent when gone), and the deps to send to it. */
function rig(state: AgentStatus) {
  const w = new World();
  const d = w.deps();
  const pane = state === "gone" ? undefined : w.addPane("t7", state);
  return { w, d, pane };
}

// The same terminal addressed bare and with its runtime prefix: both name hc terminal t7.
describe.each(["t7", "hc:t7"] as const)("send to %s (IS-2)", (target) => {
  test("an idle agent: DELIVERED at once", async () => {
    const { d, pane } = rig("idle");
    expect(await send(d, target, "hello", "cli")).toBe("DELIVERED");
    expect(pane?.received).toEqual(["hello"]);
  });

  test("a working agent: QUEUED, nothing typed, delivered by the duty pass once it is idle", async () => {
    const { d, pane } = rig("working");
    expect(await send(d, target, "later", "cli")).toBe("QUEUED");
    expect(pane?.received).toEqual([]);
    if (pane) pane.status = "idle";
    expect(await dutyTick(d)).toContainEqual({ pane: "t7", action: "flushed" });
    expect(pane?.received).toEqual(["later"]);
  });

  test("a bare shell: held in the inbox as no-agent, never typed (#66)", async () => {
    const { d, pane } = rig("shell");
    expect(await send(d, target, "rm -rf nothing", "cli")).toBe("QUEUED");
    expect(pane?.ran).toEqual([]);
    const events = await dutyTick(d);
    expect(events).toContainEqual(expect.objectContaining({ pane: "t7", action: "inbox-held" }));
    expect(d.store.queued(sref("t7")).map((m) => m.text)).toEqual(["rm -rf nothing"]);
  });

  test("a gone session: Refusal, the message kept in its inbox", async () => {
    const { w, d } = rig("gone");
    await expect(send(d, target, "anyone?", "cli")).rejects.toThrow(Refusal);
    expect(w.hcCalls("send")).toEqual([]);
    expect(d.store.queued(sref("t7"))).toHaveLength(1);
  });
});
