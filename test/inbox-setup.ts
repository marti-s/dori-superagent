import { World, sref } from "./fake.ts";

export function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("t1", "idle");
  d.store.setRole("lead", sref("t1"));
  const pane = w.addPane("t2", "idle");
  /** How many times hc was asked to type into, or press a key in, a terminal. */
  const typedInto = (id: string) => w.hcCalls("send", id).length + w.hcCalls("keys", id).length;
  const notices = () => lead.received.filter((m) => m.startsWith("[DELIVERY-AMBIGUOUS t2]"));
  return { w, d, lead, pane, typedInto, notices };
}

/** Leaves one typed entry in t2's inbox: text a delivery typed whose Enter never went through. */
export function typedEntry(s: ReturnType<typeof setup>): void {
  s.d.store.saveInbox(sref("t2"), [
    {
      at: s.w.clock,
      from: "cli",
      text: "SECRET instruction",
      attempt: { at: s.w.clock, state: "typed", detail: "key press failed" },
    },
  ]);
}

export async function captureIo(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => {
    out.push(a.join(" "));
  };
  try {
    return { code: await run(), out: out.join("\n") };
  } finally {
    console.log = log;
  }
}
