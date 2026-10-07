import { toDate, type DateInput } from "@/lib/ui/relative-time";

export type TimedDeployment = {
  status: string;
  durationMs: number | null;
  startedAt: DateInput;
  finishedAt: DateInput;
};

/**
 * End-to-end time of the most recent successful deploy, finish minus start.
 * Falls back to `durationMs`, which excludes queue wait, when a row has no finish time.
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
