// The drill-in's words: a headline and one lead sentence for the event it centers on.

import type { AppDrill } from "@/lib/admin-apps/types";
import { duration } from "@/lib/admin-apps/shape";
import { formatBytes } from "@/lib/metrics/format";

/** "14:39", on the 24-hour clock. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** The value at `t` in a stepped series, else the nearest one before it. */
function valueAt(series: (number | null)[], from: number, stepMs: number, t: number): number | null {
  for (let i = Math.min(series.length - 1, Math.floor((t - from) / stepMs)); i >= 0; i--) if (series[i] !== null) return series[i];
  return null;
}

/** The highest value between `a` and `b`. */
function peakIn(series: (number | null)[], from: number, stepMs: number, a: number, b: number): number | null {
  let peak: number | null = null;
  for (let i = Math.max(0, Math.floor((a - from) / stepMs)); i < series.length && from + i * stepMs <= b; i++) {
    const v = series[i];
    if (v !== null && (peak === null || v > peak)) peak = v;
  }
  return peak;
}

export function headline(d: AppDrill, now: number): { title: string; lead: string; tone: "issue" | null } {
  const f = d.focus;
  const deploy = f.deployId ? d.deploys.find((x) => x.id === f.deployId) : undefined;
  const base = valueAt(d.memory, d.from, d.stepMs, f.at - 60_000);
  const peak = peakIn(d.memory, d.from, d.stepMs, f.at, (f.end ?? now) + 2 * 60_000);
  const rose = base !== null && peak !== null && peak > base * 1.1;
  const memory = rose ? `memory went from ${formatBytes(base!)} to ${formatBytes(peak!)}` : null;
  const commit = deploy?.commit ? ` (${deploy.commit})` : "";
  const outage = d.outages.find((o) => o.start >= f.at && o.start <= (f.end ?? now) + 5 * 60_000);
  const down = outage ? (outage.end === null ? " Uptime checks are still failing." : ` Uptime checks failed for ${duration(outage.end - outage.start)}.`) : "";
  switch (f.kind) {
    case "rollback":
      return {
        title: `Rolled back at ${clockTime(f.end ?? f.at)}`,
        lead: `The deploy at ${clockTime(f.at)}${commit} started${memory ? `, ${memory}` : ""} and the health check failed. Vardo rolled back to the old version.${down}`,
        tone: "issue",
      };
    case "failed":
      return {
        title: `Deploy failed at ${clockTime(f.end ?? f.at)}`,
        lead: `The deploy at ${clockTime(f.at)}${commit} failed${deploy?.failure ? `: ${deploy.failure}` : ""}. The running version wasn't touched.${down}`,
        tone: "issue",
      };
    case "outage":
      return f.end === null
        ? { title: "Down now", lead: `Uptime checks have failed since ${clockTime(f.at)}.`, tone: "issue" }
        : { title: `Down at ${clockTime(f.at)}`, lead: `Uptime checks failed for ${duration(f.end - f.at)}, then recovered at ${clockTime(f.end)}.`, tone: "issue" };
    case "deploy":
      if (f.end === null) return { title: `Deploying since ${clockTime(f.at)}`, lead: `The deploy${commit} is still running.`, tone: null };
      return {
        title: `Deployed at ${clockTime(f.at)}`,
        lead: `Live in ${duration(f.end - f.at)}${commit}.${memory ? ` While both versions ran, ${memory}, then settled.` : ""}`,
        tone: null,
      };
    default:
      return { title: "Quiet for 24 hours", lead: "No deploys or outages in the last 24 hours. The chart shows the last hour.", tone: null };
  }
}
