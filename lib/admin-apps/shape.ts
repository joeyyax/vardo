// Pure shaping for the Apps page: series into fixed steps, counter rates, limits, uptime and the drill-in's focus.

import type { StageSegment } from "@/lib/pipeline/segments";
import type { CronMark, DrillEvent, Focus, LastDeploy, RibbonDeploy, RibbonSpan } from "./types";

export type Point = [number, number];

/** Step index for `t`, or -1 outside the window. */
function slot(t: number, from: number, stepMs: number, n: number): number {
  const i = Math.floor((t - from) / stepMs);
  return i >= 0 && i < n ? i : -1;
}

/** Points averaged into `n` steps from `from`; null where none landed. */
export function bucketSeries(points: Point[], from: number, stepMs: number, n: number): (number | null)[] {
  const sum = new Array<number>(n).fill(0);
  const count = new Array<number>(n).fill(0);
  for (const [t, v] of points) {
    const i = slot(t, from, stepMs, n);
    if (i < 0 || !Number.isFinite(v)) continue;
    sum[i] += v;
    count[i]++;
  }
  return sum.map((s, i) => (count[i] ? s / count[i] : null));
}

/** Bytes per second from one container's cumulative counter. A drop is a restart: that step is null. */
export function counterRates(points: Point[], from: number, stepMs: number, n: number): (number | null)[] {
  const out = new Array<number | null>(n).fill(null);
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < sorted.length; k++) {
    const [t0, v0] = sorted[k - 1];
    const [t1, v1] = sorted[k];
    const i = slot(t1, from, stepMs, n);
    if (i < 0 || t1 <= t0 || v1 < v0) continue;
    out[i] = (v1 - v0) / ((t1 - t0) / 1000);
  }
  return out;
}

/** Step-wise sum across series; a step stays null only when every series is. */
export function sumSeries(list: (number | null)[][], n: number): (number | null)[] {
  const out = new Array<number | null>(n).fill(null);
  for (const s of list) {
    for (let i = 0; i < n; i++) {
      const v = s[i];
      if (v === null || v === undefined) continue;
      out[i] = (out[i] ?? 0) + v;
    }
  }
  return out;
}

/** The newest value within the last `fresh` steps. */
export function latest(series: (number | null)[], fresh = 3): number | null {
  for (let i = series.length - 1; i >= Math.max(0, series.length - fresh); i--) {
    if (series[i] !== null) return series[i];
  }
  return null;
}

/** Memory limit of an app or a stack's members in bytes. Null when any one is unlimited or unknown. */
export function memoryLimitOf(members: { containerMemoryLimit: number | null; memoryLimit: number | null }[]): number | null {
  if (members.length === 0) return null;
  let total = 0;
  for (const m of members) {
    const bytes = m.containerMemoryLimit && m.containerMemoryLimit > 0 ? m.containerMemoryLimit : m.memoryLimit && m.memoryLimit > 0 ? m.memoryLimit * 1024 ** 2 : null;
    if (bytes === null) return null;
    total += bytes;
  }
  return total;
}

/** Share of monitored minutes that were up; null when nothing was measured. */
export function uptimeRatio(up: number, down: number): number | null {
  return up + down > 0 ? up / (up + down) : null;
}

/** A deploy on the ribbon from its segments: queue to finish, with its waits for a builder. */
export function ribbonDeploy(d: { queuedAt: number; finishedAt: number | null; status: string; segments: StageSegment[] }): RibbonDeploy {
  return {
    start: d.queuedAt,
    end: d.finishedAt,
    failed: d.status === "failed" || d.status === "rolled_back",
    waits: d.segments.filter((s) => s.stage === "wait").map((s) => ({ start: s.start, end: s.end })),
  };
}

/** Cron runs grouped into marks of `bucketMs`. */
export function cronMarks(runs: { at: number; failed: boolean }[], bucketMs: number): CronMark[] {
  const by = new Map<number, CronMark>();
  for (const r of runs) {
    const at = Math.floor(r.at / bucketMs) * bucketMs;
    const m = by.get(at) ?? { at, runs: 0, failed: 0 };
    m.runs++;
    if (r.failed) m.failed++;
    by.set(at, m);
  }
  return [...by.values()].sort((a, b) => a.at - b.at);
}

/** Overlapping spans merged, as several monitors report one outage. */
export function mergeSpans(spans: RibbonSpan[]): RibbonSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: RibbonSpan[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && (last.end === null || s.start <= last.end)) {
      last.end = last.end === null || s.end === null ? null : Math.max(last.end, s.end);
      last.failed ||= s.failed;
    } else out.push({ ...s });
  }
  return out;
}

export function lastDeployOf(row: { status: string; startedAt: number; finishedAt: number } | null): LastDeploy | null {
  if (!row) return null;
  const status = row.status === "failed" || row.status === "rolled_back" || row.status === "cancelled" ? row.status : "success";
  return { at: row.finishedAt, ms: Math.max(0, row.finishedAt - row.startedAt), status };
}

export type FocusDeploy = { id: string; status: string; queuedAt: number; finishedAt: number | null };

/** An outage starting this soon after a bad deploy finished belongs to that deploy. */
const CAUSED_MS = 5 * 60_000;

/** The latest notable event: a rollback, failure or outage beats a plain deploy. An outage a bad deploy caused reads as the deploy. */
export function pickFocus(deploys: FocusDeploy[], outages: RibbonSpan[], now: number): Focus {
  const failed = deploys
    .filter((d) => d.status === "rolled_back" || d.status === "failed")
    .map((d): Focus => ({ kind: d.status === "rolled_back" ? "rollback" : "failed", at: d.queuedAt, end: d.finishedAt, deployId: d.id }));
  const caused = (o: RibbonSpan) => failed.some((f) => o.start >= f.at && o.start <= (f.end ?? now) + CAUSED_MS);
  const bad: Focus[] = [...failed, ...outages.filter((o) => !caused(o)).map((o): Focus => ({ kind: "outage", at: o.start, end: o.end, deployId: null }))];
  if (bad.length) return bad.sort((a, b) => b.at - a.at)[0];
  const last = [...deploys].sort((a, b) => b.queuedAt - a.queuedAt)[0];
  if (last) return { kind: "deploy", at: last.queuedAt, end: last.finishedAt, deployId: last.id };
  return { kind: "quiet", at: now, end: null, deployId: null };
}

const MIN = 60_000;

/** The chart's window: 25 minutes before the focus to 35 after, never past now. A quiet app shows its last hour. */
export function focusWindow(focus: Focus, now: number): { from: number; to: number } {
  if (focus.kind === "quiet") return { from: now - 60 * MIN, to: now };
  const to = Math.min(now, focus.at + 35 * MIN);
  return { from: Math.min(focus.at - 25 * MIN, to - 60 * MIN), to };
}

/** "4:05", "1:02:03". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export type EventInputs = {
  deploys: (FocusDeploy & { failure: string | null })[];
  outages: RibbonSpan[];
  backups: RibbonSpan[];
  crons: { at: number; name: string; failed: boolean }[];
};

/** The recent list: deploys, outages, backups and failed cron runs, newest first. */
export function drillEvents(input: EventInputs, now: number, limit = 7): DrillEvent[] {
  const out: DrillEvent[] = [];
  for (const d of input.deploys) {
    if (d.finishedAt === null) out.push({ at: d.queuedAt, text: "Deploying", tone: "default" });
    else if (d.status === "rolled_back") out.push({ at: d.queuedAt, text: `Deploy rolled back${d.failure ? ` · ${d.failure}` : ""}`, tone: "issue" });
    else if (d.status === "failed") out.push({ at: d.queuedAt, text: `Deploy failed${d.failure ? ` · ${d.failure}` : ""}`, tone: "issue" });
    else if (d.status === "cancelled") out.push({ at: d.queuedAt, text: "Deploy cancelled", tone: "default" });
    else out.push({ at: d.queuedAt, text: `Deployed · ${duration(d.finishedAt - d.queuedAt)}`, tone: "default" });
  }
  for (const o of input.outages) out.push({ at: o.start, text: o.end === null ? "Down now" : `Down ${duration(o.end - o.start)}`, tone: "issue" });
  for (const b of input.backups) {
    if (b.end === null) out.push({ at: b.start, text: "Backing up", tone: "default" });
    else out.push({ at: b.start, text: b.failed ? "Backup failed" : "Backed up", tone: b.failed ? "issue" : "default" });
  }
  for (const c of input.crons) if (c.failed) out.push({ at: c.at, text: `${c.name} failed`, tone: "issue" });
  return out.filter((e) => e.at <= now).sort((a, b) => b.at - a.at).slice(0, limit);
}
