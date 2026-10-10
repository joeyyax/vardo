// Host readings and the alerts they raise: memory, swap, CPU, load and disk.

import { readFile } from "fs/promises";
import os from "os";
import type { AlertItem } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import type { Observation } from "@/lib/notifications/observations";
import type { AlertType } from "@/lib/notifications/registry";
import { judgeThreshold, type Point, type ThresholdRule, type Verdict } from "./threshold";

export type HostSample = {
  at: number;
  memory: { percent: number; used: number; total: number } | null;
  swap: { percent: number; used: number; total: number } | null;
  cpuPercent: number | null;
  /** 5-minute load average over core count. */
  load: { avg5: number; cores: number; ratio: number } | null;
  disk: { percent: number; used: number; total: number } | null;
};

export const HOST_RULES: Record<"host.memory" | "host.swap" | "host.cpu" | "host.load" | "host.disk", ThresholdRule> = {
  "host.memory": { warn: 85, critical: 95, clearBelow: 80, sustainMs: 5 * 60_000 },
  "host.swap": { warn: 50, critical: 80, clearBelow: 40, sustainMs: 10 * 60_000 },
  "host.cpu": { warn: 90, critical: 98, clearBelow: 80, sustainMs: 10 * 60_000 },
  "host.load": { warn: 2, critical: 4, clearBelow: 1.5, sustainMs: 10 * 60_000 },
  "host.disk": { warn: 85, critical: 95, clearBelow: 80, sustainMs: 0 },
};

export const HOST_ALERT_TYPES = Object.keys(HOST_RULES) as (keyof typeof HOST_RULES)[];

/** `MemTotal`, `MemAvailable`, `SwapTotal`, `SwapFree` in bytes. */
export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
}

function share(used: number, total: number): { percent: number; used: number; total: number } | null {
  return total > 0 ? { percent: (used / total) * 100, used, total } : null;
}

let lastCpu: { idle: number; total: number } | null = null;

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Busy share since the previous call. Null on the first. */
function cpuPercent(): number | null {
  const now = cpuTimes();
  const prev = lastCpu;
  lastCpu = now;
  if (!prev || now.total <= prev.total) return null;
  return (1 - (now.idle - prev.idle) / (now.total - prev.total)) * 100;
}

/** Reads the host the console runs on. /proc is the host's inside a container. */
export async function readHostSample(disk: HostSample["disk"], now = Date.now()): Promise<HostSample> {
  let memory: HostSample["memory"] = null;
  let swap: HostSample["swap"] = null;
  try {
    const info = parseMeminfo(await readFile("/proc/meminfo", "utf-8"));
    if (info.MemTotal && info.MemAvailable !== undefined) memory = share(info.MemTotal - info.MemAvailable, info.MemTotal);
    if (info.SwapTotal && info.SwapFree !== undefined) swap = share(info.SwapTotal - info.SwapFree, info.SwapTotal);
  } catch {
    memory = share(os.totalmem() - os.freemem(), os.totalmem());
  }
  const cores = os.cpus().length;
  const avg5 = os.loadavg()[1];
  return {
    at: now,
    memory,
    swap,
    cpuPercent: cpuPercent(),
    load: cores > 0 ? { avg5, cores, ratio: avg5 / cores } : null,
    disk,
  };
}

/** The last two hours of readings, in memory. */
export class HostSampleBuffer {
  private samples: HostSample[] = [];
  constructor(private keepMs = 2 * 60 * 60_000) {}

  push(sample: HostSample): void {
    this.samples.push(sample);
    const cutoff = sample.at - this.keepMs;
    while (this.samples.length > 0 && this.samples[0].at < cutoff) this.samples.shift();
  }

  latest(): HostSample | undefined {
    return this.samples.at(-1);
  }

  points(read: (s: HostSample) => number | null | undefined, sinceMs = 0): Point[] {
    return this.samples.flatMap((s) => {
      const value = read(s);
      return s.at >= sinceMs && value !== null && value !== undefined ? [{ at: s.at, value }] : [];
    });
  }
}

const READ: Record<keyof typeof HOST_RULES, (s: HostSample) => number | null | undefined> = {
  "host.memory": (s) => s.memory?.percent,
  "host.swap": (s) => s.swap?.percent,
  "host.cpu": (s) => s.cpuPercent,
  "host.load": (s) => s.load?.ratio,
  "host.disk": (s) => s.disk?.percent,
};

/** At most `max` values, averaged down, oldest first. */
export function downsample(values: number[], max = 30): number[] {
  if (values.length <= max) return values;
  const size = values.length / max;
  return Array.from({ length: max }, (_, i) => {
    const slice = values.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    return slice.reduce((a, b) => a + b, 0) / Math.max(1, slice.length);
  });
}

const pct = (n: number) => `${Math.round(n)}%`;

export type HostContext = {
  /** Biggest containers by memory, for the memory alert. */
  topMemory?: { name: string; bytes: number }[];
};

function hostItem(type: keyof typeof HOST_RULES, verdict: Verdict, s: HostSample, hour: number[], ctx: HostContext): AlertItem {
  const rule = HOST_RULES[type];
  const base = { type, about: "host", severity: verdict.severity };
  const minutes = Math.round(rule.sustainMs / 60_000);
  switch (type) {
    case "host.memory": {
      const m = s.memory!;
      return {
        ...base,
        title: `Memory ${pct(m.percent)} used`,
        detail: "Available memory is low. Deploys can fail and the kernel starts killing containers. Stop or limit what's using it.",
        gauge: { title: "Memory used", percent: m.percent, warn: rule.warn, critical: rule.critical },
        series: { title: "Memory, last hour", values: hour, caption: `Over ${rule.warn}% for ${minutes} min` },
        facts: [
          { label: "Used", value: `${formatBytesIec(m.used)} of ${formatBytesIec(m.total)}` },
          { label: "Available", value: formatBytesIec(m.total - m.used) },
          ...(ctx.topMemory?.length
            ? [{ label: "Top containers", value: ctx.topMemory.map((c) => `${c.name} ${formatBytesIec(c.bytes)}`).join(", ") }]
            : []),
        ],
      };
    }
    case "host.swap": {
      const w = s.swap!;
      return {
        ...base,
        title: `Swap ${pct(w.percent)} used`,
        detail: "The host is paging memory to disk, which slows every app on it. Free memory or add RAM.",
        gauge: { title: "Swap used", percent: w.percent, warn: rule.warn, critical: rule.critical },
        series: { title: "Swap, last hour", values: hour },
        facts: [{ label: "Used", value: `${formatBytesIec(w.used)} of ${formatBytesIec(w.total)}` }],
      };
    }
    case "host.cpu":
      return {
        ...base,
        title: `CPU over ${rule.warn}% for ${minutes} min`,
        detail: "Something has kept the CPU busy. Check for a runaway process or a build that didn't finish.",
        gauge: { title: "CPU", percent: verdict.value, warn: rule.warn, critical: rule.critical },
        series: { title: "CPU, last hour", values: hour },
      };
    case "host.load": {
      const l = s.load!;
      return {
        ...base,
        title: `Load ${l.avg5.toFixed(1)} on ${l.cores} cores`,
        detail: "More work is waiting than the CPUs can run, often from slow disk I/O. Apps respond slowly until it drops.",
        series: { title: "Load per core, last hour", values: hour },
        facts: [
          { label: "Load (5 min)", value: l.avg5.toFixed(2) },
          { label: "Cores", value: String(l.cores) },
        ],
      };
    }
    case "host.disk": {
      const d = s.disk!;
      return {
        ...base,
        title: `Disk ${pct(d.percent)} full`,
        detail: "Deploys and backups fail once the disk is full. Prune old images and build cache or grow the disk.",
        gauge: { title: "Disk used", percent: d.percent, warn: rule.warn, critical: rule.critical },
        facts: [
          { label: "Used", value: `${formatBytesIec(d.used)} of ${formatBytesIec(d.total)}` },
          { label: "Free", value: formatBytesIec(Math.max(0, d.total - d.used)) },
        ],
      };
    }
  }
}

/**
 * Host observations and the types they settle. A type with no fresh reading is left out of
 * `evaluated`, so a restart neither fires nor clears it.
 */
export function hostObservations(
  buffer: HostSampleBuffer,
  now: number,
  ctx: HostContext,
  opts: { memoryConfirmed?: boolean } = {},
): { evaluated: AlertType[]; observations: Observation[] } {
  const latest = buffer.latest();
  const evaluated: AlertType[] = [];
  const observations: Observation[] = [];
  if (!latest) return { evaluated, observations };

  for (const type of HOST_ALERT_TYPES) {
    if (READ[type](latest) == null) continue;
    const points = buffer.points(READ[type]);
    const verdict = judgeThreshold(points, HOST_RULES[type], now, {
      waiveSustain: type === "host.memory" && opts.memoryConfirmed,
    });
    if (!verdict) continue;
    evaluated.push(type);
    if (!verdict.holds) continue;
    const hour = downsample(buffer.points(READ[type], now - 60 * 60_000).map((p) => p.value));
    observations.push({ type, about: "host", severity: verdict.severity, fires: verdict.fires, item: hostItem(type, verdict, latest, hour, ctx) });
  }
  return { evaluated, observations };
}
