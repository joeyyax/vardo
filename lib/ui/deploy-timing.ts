import { toDate, type DateInput } from "@/lib/ui/relative-time";

export type TimedDeployment = {
  status: string;
  durationMs: number | null;
  startedAt: DateInput;
  finishedAt: DateInput;
};

/**
 * Run time of the most recent successful deploy: `durationMs`, which excludes queue wait.
 * Falls back to finish minus start for a row without one.
 */
export function typicalElapsedMs(deployments: TimedDeployment[]): number | null {
  for (const d of deployments) {
    if (d.status !== "success") continue;
    if (d.durationMs && d.durationMs > 0) return d.durationMs;

    const started = toDate(d.startedAt);
    const finished = toDate(d.finishedAt);
    if (started && finished) {
      const elapsed = finished.getTime() - started.getTime();
      if (elapsed > 0) return elapsed;
    }
  }

  return null;
}
