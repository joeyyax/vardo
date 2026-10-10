// In-memory detection state: recent readings, five-minute samples to persist and which signals are in an episode.

import { SAMPLE_MS, isWarm, statsAt, type Baseline, type Sample, type ZoneOffset } from "./baseline";
import { judgeSignal, lineFor } from "./detect";
import type { Finding } from "./items";
import { SIGNALS, SIGNAL_KEYS, type Sensitivity, type SignalKey } from "./signals";

/** Readings kept for detection and the email's chart. */
export const RECENT_MS = 60 * 60_000;
/** An episode this old is taken as the new normal and feeds the baseline again. */
export const NEW_NORMAL_MS = 24 * 60 * 60_000;

type Accumulator = { bucket: number; sum: number; n: number; tainted: boolean };

export type Evaluation =
  /** Nothing to judge: quiet window, warming up or no fresh readings. An open alert should hold. */
  | { state: "unknown" }
  | { state: "judged"; findings: Finding[] };

const key = (appId: string, signal: SignalKey) => `${appId}:${signal}`;

export class AnomalyEngine {
  private recent = new Map<string, Sample[]>();
  private acc = new Map<string, Accumulator>();
  /** Signal key to when its episode opened. */
  private episodes = new Map<string, number>();

  /** Records one reading per signal and returns finished five-minute samples, minus quiet or episode ones. */
  record(appId: string, values: Partial<Record<SignalKey, number>>, at: number, quiet: boolean): { signal: SignalKey; at: number; value: number }[] {
    const out: { signal: SignalKey; at: number; value: number }[] = [];
    for (const signal of SIGNAL_KEYS) {
      const value = values[signal];
      if (value === undefined || !Number.isFinite(value)) continue;
      const k = key(appId, signal);

      const list = this.recent.get(k) ?? [];
      list.push({ at, value });
      while (list.length > 0 && list[0].at <= at - RECENT_MS) list.shift();
      this.recent.set(k, list);

      const bucket = Math.floor(at / SAMPLE_MS) * SAMPLE_MS;
      const opened = this.episodes.get(k);
      const tainted = quiet || (opened !== undefined && at - opened < NEW_NORMAL_MS);
      const current = this.acc.get(k);
      if (current && current.bucket !== bucket) {
        if (!current.tainted && current.n > 0) out.push({ signal, at: current.bucket, value: current.sum / current.n });
        this.acc.delete(k);
      }
      const next = this.acc.get(k) ?? { bucket, sum: 0, n: 0, tainted: false };
      next.sum += value;
      next.n += 1;
      next.tainted ||= tainted;
      this.acc.set(k, next);
    }
    return out;
  }

  recentValues(appId: string, signal: SignalKey): Sample[] {
    return this.recent.get(key(appId, signal)) ?? [];
  }

  /** Judges every warm signal against its baseline for the hour. */
  evaluate(
    appId: string,
    baselines: Partial<Record<SignalKey, Baseline | null>>,
    opts: { now: number; sensitivity: Sensitivity; offset: ZoneOffset; quiet: boolean },
  ): Evaluation {
    if (opts.quiet) return { state: "unknown" };
    const findings: Finding[] = [];
    let judged = 0;
    for (const signal of SIGNAL_KEYS) {
      const k = key(appId, signal);
      const baseline = baselines[signal];
      if (!isWarm(baseline, opts.now)) {
        this.episodes.delete(k);
        continue;
      }
      const stats = statsAt(baseline, opts.now, opts.offset);
      const points = this.recentValues(appId, signal);
      if (!stats) continue;
      const verdict = judgeSignal(points, SIGNALS[signal], lineFor(SIGNALS[signal], stats, opts.sensitivity), opts.now);
      if (!verdict) continue;
      judged++;
      if (verdict.holds) {
        if (!this.episodes.has(k)) this.episodes.set(k, opts.now);
        findings.push({ signal, verdict, recent: points.map((p) => p.value) });
      } else {
        this.episodes.delete(k);
      }
    }
    return judged === 0 ? { state: "unknown" } : { state: "judged", findings };
  }

  /** Forgets apps no longer watched. */
  retain(appIds: Set<string>): void {
    for (const map of [this.recent, this.acc]) {
      for (const k of map.keys()) if (!appIds.has(k.slice(0, k.lastIndexOf(":")))) map.delete(k);
    }
    for (const k of this.episodes.keys()) if (!appIds.has(k.slice(0, k.lastIndexOf(":")))) this.episodes.delete(k);
  }
}
