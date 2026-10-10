"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import { CronStatusIcon, type CronRun } from "./cron-shared";

type Props = {
  orgId: string;
  jobId: string;
  /** Changes after a run so the list reloads. */
  refreshKey?: number;
};

function formatMs(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** A job's recent runs, newest first, each with its output on demand. */
export function CronRuns({ orgId, jobId, refreshKey = 0 }: Props) {
  const [runs, setRuns] = useState<CronRun[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/organizations/${orgId}/cron/${jobId}?runs=10`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { runs: CronRun[] }) => {
        if (!cancelled) setRuns(data.runs);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, jobId, refreshKey]);

  if (failed) return <p className="text-xs text-muted-foreground">Couldn&apos;t load runs.</p>;
  if (!runs) return <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading runs" />;
  if (runs.length === 0) return <p className="text-xs text-muted-foreground">No runs yet.</p>;

  return (
    <ul className="divide-y rounded-md border text-xs">
      {runs.map((run) => {
        const log = run.output ?? run.error;
        return (
          <li key={run.id} className="px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <CronStatusIcon status={run.status} />
              <RelativeTime date={run.startedAt} className="text-muted-foreground" />
              {run.httpStatus !== null && <span className="font-mono">HTTP {run.httpStatus}</span>}
              {run.durationMs !== null && <span className="text-muted-foreground">{formatMs(run.durationMs)}</span>}
              {run.attempts !== null && run.attempts > 1 && (
                <span className="text-muted-foreground">{run.attempts} attempts</span>
              )}
              {log && (
                <button
                  type="button"
                  className="ml-auto text-muted-foreground hover:text-foreground"
                  aria-expanded={open === run.id}
                  onClick={() => setOpen(open === run.id ? null : run.id)}
                >
                  {open === run.id ? "Hide output" : "Show output"}
                </button>
              )}
            </div>
            {open === run.id && log && (
              <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-zinc-950 p-3 text-zinc-300">{log}</pre>
            )}
          </li>
        );
      })}
    </ul>
  );
}
