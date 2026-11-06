import type { GuardThresholds } from "./config.ts";
import type { Runner } from "./run.ts";

export type HostSample = {
  readonly load1: number;
  readonly memFreePct: number;
  readonly diskFreeGb: number;
  readonly swapFreeGb: number;
  readonly panes: number;
};

const num = (s: string | undefined, fallback: number): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};

export const sampleHost = async (run: Runner, dataPath = "/"): Promise<HostSample> => {
  const load = await run(["sysctl", "-n", "vm.loadavg"]);
  const loadLinux = load.code === 0 ? null : await run(["cat", "/proc/loadavg"]);
  const load1 = num((load.code === 0 ? load.out.replace(/[{}]/g, "").trim() : loadLinux?.out ?? "").split(/\s+/)[0], 0);
  const mp = await run(["memory_pressure", "-Q"]);
  const memInfo = mp.code === 0 ? null : await run(["cat", "/proc/meminfo"]);
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(memInfo?.out ?? "");
    return m ? Number(m[1]) : null;
  };
  const total = kb("MemTotal"), available = kb("MemAvailable");
  const memFreePct = mp.code === 0
    ? num(/free percentage: (\d+)%/.exec(mp.out)?.[1], 100)
    : total !== null && total > 0 && available !== null ? Math.round((available / total) * 100) : 100;
  const df = await run(["df", "-k", dataPath]);
  const diskFreeGb = num(df.out.split("\n").at(-1)?.trim().split(/\s+/)[3], 0) / 1_048_576;
  const swap = await run(["sysctl", "-n", "vm.swapusage"]);
  const swapFreeGb = num(/free = ([\d.]+)M/.exec(swap.out)?.[1], 0) / 1024;
  const pl = await run(["hc", "ls", "--json"]);
  const panes = pl.code === 0 ? ((JSON.parse(pl.out) as { terminals?: unknown[] }).terminals ?? []).length : -1;
  return { load1, memFreePct, diskFreeGb, swapFreeGb, panes };
};

export const alertReasons = (s: HostSample, t: GuardThresholds): string[] => {
  const r: string[] = [];
  if (s.load1 > t.loadAlert) r.push(`load ${s.load1.toFixed(0)} > ${t.loadAlert}`);
  if (s.memFreePct < t.memFreeMinPct) r.push(`memory free ${s.memFreePct}% < ${t.memFreeMinPct}%`);
  if (s.diskFreeGb < t.diskFreeMinGb) r.push(`disk free ${s.diskFreeGb.toFixed(0)} GB < ${t.diskFreeMinGb} GB`);
  if (t.panesMax > 0 && s.panes > t.panesMax) r.push(`panes ${s.panes} > ${t.panesMax}`);
  return r;
};

export type GuardState = { alerting: boolean; computeReady?: boolean };

export const guardTick = (s: HostSample, t: GuardThresholds, state: GuardState): string[] => {
  const out: string[] = [];
  const reasons = alertReasons(s, t);
  const alerting = reasons.length > 0;
  if (alerting !== state.alerting) {
    out.push(alerting
      ? `HOST_GUARD ALERT ${reasons.join(" | ")}`
      : `HOST_GUARD CLEAR load ${s.load1.toFixed(0)}, memory free ${s.memFreePct}%, disk free ${s.diskFreeGb.toFixed(0)} GB, swap free ${s.swapFreeGb.toFixed(1)} GB`);
    state.alerting = alerting;
  }
  const ready = s.load1 < t.loadOk;
  if (ready !== state.computeReady) {
    out.push(ready ? `HOST_GUARD COMPUTE_READY load ${s.load1.toFixed(0)} < ${t.loadOk}` : `HOST_GUARD COMPUTE_BUSY load ${s.load1.toFixed(0)}`);
    state.computeReady = ready;
  }
  return out;
};
