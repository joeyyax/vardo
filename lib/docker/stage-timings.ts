import type { WaitWriter } from "./deploy-logger";

/** Wall-clock timings for the deploy phases #777 breaks a build down by. */
export const TIMED_PHASES = ["clone", "build", "export", "pull", "up", "healthWait", "cleanup"] as const;
export type TimedPhase = (typeof TIMED_PHASES)[number];

export type PhaseTiming = { startedAt: string; endedAt: string; ms: number };
/** `waitMs` is time the run spent waiting for the builder or the checkout, which no phase counts. */
export type StageTimings = Partial<Record<TimedPhase, PhaseTiming>> & { waitMs?: number };

/** Deploy stages whose duration is a timed phase. */
export const STAGE_PHASE: Partial<Record<string, TimedPhase>> = {
  clone: "clone",
  healthcheck: "healthWait",
  cleanup: "cleanup",
};

/** Accumulates phases. A phase hit twice (two pulls) sums its time and spans first start to last end. */
export function createStageTimings() {
  const timings: StageTimings = {};
  const open = new Map<TimedPhase, number>();
  let waitedMs = 0;
  let waitOpen: number | null = null;

  function record(phase: TimedPhase, startMs: number, endMs: number) {
    const prev = timings[phase];
    timings[phase] = {
      startedAt: prev?.startedAt ?? new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      ms: (prev?.ms ?? 0) + Math.max(0, Math.round(endMs - startMs)),
    };
  }

  function begin(phase: TimedPhase, now = Date.now()) {
    if (!open.has(phase)) open.set(phase, now);
  }

  function end(phase: TimedPhase, now = Date.now()) {
    const start = open.get(phase);
    if (start === undefined) return;
    open.delete(phase);
    record(phase, start, now);
  }

  /** Closes phases a failed deploy left open. */
  function endAll(now = Date.now()) {
    for (const phase of [...open.keys()]) end(phase, now);
  }

  async function span<T>(phase: TimedPhase, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      record(phase, start, Date.now());
    }
  }

  /** Records a phase measured elsewhere, as epoch milliseconds. */
  function range(phase: TimedPhase, startMs: number, endMs: number) {
    record(phase, startMs, endMs);
  }

  /** Starts the wait tally; a wait already open keeps its start. */
  function waitBegin(now = Date.now()) {
    if (waitOpen === null) waitOpen = now;
  }

  function waitEnd(now = Date.now()) {
    if (waitOpen === null) return;
    waitedMs += Math.max(0, now - waitOpen);
    waitOpen = null;
  }

  /** Time spent waiting so far, an open wait included. */
  function waited(now = Date.now()): number {
    return waitedMs + (waitOpen === null ? 0 : Math.max(0, now - waitOpen));
  }

  function snapshot(): StageTimings {
    const ms = Math.round(waited());
    return ms > 0 ? { ...timings, waitMs: ms } : { ...timings };
  }

  return { begin, end, endAll, span, range, snapshot, waitBegin, waitEnd, waited };
}

export type StageTimer = ReturnType<typeof createStageTimings>;

/** Wraps a wait writer to tally its waits on `timer`. */
export function timedWait(timer: StageTimer, writer: WaitWriter): WaitWriter {
  return (reason, place) => {
    if (reason === null) timer.waitEnd();
    else timer.waitBegin();
    return writer(reason, place);
  };
}

/** One line for the deploy log: `[timing] clone 3.2s, build 40.1s`. */
export function formatTimings(timings: StageTimings): string {
  const parts = TIMED_PHASES.flatMap((p) => {
    const t = timings[p];
    return t ? [`${p} ${(t.ms / 1000).toFixed(1)}s`] : [];
  });
  if (timings.waitMs) parts.push(`waited ${(timings.waitMs / 1000).toFixed(1)}s`);
  return parts.length ? `[timing] ${parts.join(", ")}` : "";
}

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };

/** Bytes of build context BuildKit sent, from `#4 transferring context: 12.3MB 0.4s done` lines. Null when none. */
export function contextBytesFromBuildOutput(output: string): number | null {
  const steps = new Map<string, number>();
  for (const line of output.split(/\r?\n|\r/)) {
    const m = line.match(/^(?:\[[^\]]*\] )?#(\d+) (?:\[[^\]]*\] )?transferring context: ([\d.]+)\s*([kKMGT]?i?B)\b/);
    if (!m) continue;
    const unit = SIZE_UNITS[m[3].toLowerCase()];
    if (unit) steps.set(m[1], Math.round(Number(m[2]) * unit));
  }
  return steps.size ? [...steps.values()].reduce((a, b) => a + b, 0) : null;
}

/**
 * Seconds BuildKit spent exporting images, from `--progress=plain` output:
 * `#25 sending tarball` ... `#25 DONE 14.3s`. Cached steps carry no duration.
 */
export function exportMsFromBuildOutput(output: string): number {
  const exportSteps = new Set<string>();
  let ms = 0;
  for (const line of output.split(/\r?\n|\r/)) {
    const step = line.match(/^#(\d+) (?:sending tarball|exporting to (?:docker image format|image|oci image format))/);
    if (step) exportSteps.add(step[1]);
    const done = line.match(/^#(\d+) DONE ([\d.]+)s/);
    if (done && exportSteps.has(done[1])) ms += Math.round(Number(done[2]) * 1000);
  }
  return ms;
}
