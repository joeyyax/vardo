"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bug, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { HeaderStat } from "@/components/entity-header";
import {
  BASELINE_MS,
  MIN_BASELINE_SPAN_MS,
  SAMPLE_MS,
  WINDOW_MS,
  errorRateSurface,
  errorRateTone,
  type ErrorRateReading,
  type RateSample,
} from "@/lib/ui/error-rate";

type Response = {
  available: boolean;
  reading?: ErrorRateReading;
  samples?: RateSample[];
};

const WINDOW_MINUTES = Math.round(WINDOW_MS / 60_000);
const BASELINE_DAYS = Math.round(BASELINE_MS / 86_400_000);

/**
 * Whether this app is logging errors faster than it normally does. Nothing
 * classifies or groups the errors — that needs an SDK inside the app. Counting
 * and comparing works on any image, including ones nobody here built.
 */
export function AppErrors({
  appName,
  appId,
  orgId,
}: {
  appName: string;
  appId: string;
  orgId: string;
}) {
  const [data, setData] = useState<Response | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/organizations/${orgId}/apps/${appId}/error-rate`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: Response | null) => {
        if (!cancelled) setData(body ?? { available: false });
      })
      .catch(() => {
        if (!cancelled) setData({ available: false });
      });
    return () => { cancelled = true; };
  }, [orgId, appId]);

  if (data && (!data.available || !data.reading)) {
    return (
      <EmptyState
        className="p-8"
        icon={Bug}
        title="Log collection not available"
        body="Error rates are derived from container logs. Turn on logging and give it a few days to learn what normal looks like for this app."
      />
    );
  }

  const reading = data?.reading;
  const samples = data?.samples ?? [];
  // Windowed off the newest sample, not the wall clock — the day shown is the
  // day that was collected.
  const newest = samples.length > 0 ? samples[samples.length - 1].at : 0;
  const lastDay = samples.filter((s) => s.at > newest - 86_400_000);

  return (
    <div className="space-y-6">
      <div className={`squircle rounded-lg border p-4 ${errorRateSurface(reading?.status ?? "idle")}`}>
        <div className="flex flex-wrap items-center gap-2">
          <TriangleAlert
            className={`size-4 shrink-0 ${errorRateTone(reading?.status ?? "idle")}`}
            aria-hidden="true"
          />
          <span className={`font-medium ${errorRateTone(reading?.status ?? "idle")}`}>
            {reading?.headline ?? "Reading…"}
          </span>
        </div>
        {reading && <p className="mt-1.5 text-sm text-muted-foreground">{reading.detail}</p>}
      </div>

      <dl className="flex flex-wrap gap-x-10 gap-y-4">
        <HeaderStat
          label={`Matches · ${WINDOW_MINUTES}m`}
          hint="Log lines matching a coarse error shape in the last half hour. Not a count of distinct problems — one fault can print many lines."
        >
          <span className="tabular-nums">{reading?.recent ?? "—"}</span>
        </HeaderStat>
        <HeaderStat
          label="Usual"
          hint={`The median half hour over the past ${BASELINE_DAYS} days, with deploys and restarts left out.`}
        >
          <span className="tabular-nums">{reading?.baseline ?? "—"}</span>
        </HeaderStat>
        <HeaderStat label={`Last 24h`}>
          <span className="tabular-nums">
            {lastDay.length > 0 ? lastDay.reduce((n, s) => n + s.errors, 0) : "—"}
          </span>
        </HeaderStat>
      </dl>

      {reading?.status === "learning" && (
        <Coverage coverage={reading.coverage} />
      )}

      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Counted straight off the log stream, so it works for images nobody here built. It answers
          whether this app is noisier than usual, not what went wrong — the lines themselves say that.
        </p>
        <Button asChild size="sm" variant="outline">
          <Link href={`/apps/${appName}/logs/errors`}>View error lines</Link>
        </Button>
      </div>
    </div>
  );
}

/** How much of the baseline exists, while it is still being built. */
function Coverage({ coverage }: { coverage: number }) {
  const target = MIN_BASELINE_SPAN_MS / BASELINE_MS;
  const pct = Math.min(100, Math.round((coverage / target) * 100));
  return (
    <div className="space-y-1.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-status-neutral" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        {pct}% of the history needed to compare. Samples land every{" "}
        {Math.round(SAMPLE_MS / 60_000)} minutes while the app is running.
      </p>
    </div>
  );
}
