import { toDate, type DateInput } from "@/lib/ui/relative-time";

export type TimedDeployment = {
  status: string;
  durationMs: number | null;
  startedAt: DateInput;
  finishedAt: DateInput;
};

/**
 * End-to-end time of the most recent successful deploy — the yardstick the
 * in-progress header compares its timer against.
 *
 * `durationMs` clocks execution only; the header's timer runs from the moment
 * the deploy was requested. Measuring finish-minus-start keeps both sides on
 * the same quantity, so queue wait counts on both or neither. Falls back to
 * `durationMs` when a row has no finish time.
 */
export function typicalElapsedMs(deployments: TimedDeployment[]): number | null {
  for (const d of deployments) {
    if (d.status !== "success") continue;

    const started = toDate(d.startedAt);
    const finished = toDate(d.finishedAt);
    if (started && finished) {
      const elapsed = finished.getTime() - started.getTime();
      if (elapsed > 0) return elapsed;
    }

    if (d.durationMs) return d.durationMs;
  }

  return null;
}
