"use client";

import { useEffect, useState } from "react";
import { Activity, TrendingDown, TrendingUp } from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
import { HeaderStat } from "@/components/entity-header";
import type { AppCondition } from "@/lib/docker/conditions";
import type { ExitReason } from "@/lib/docker/exit-reason";
import {
  heldFor,
  incidentLabel,
  incidentTone,
  isFault,
  restartCaption,
  restartTone,
  stabilitySurface,
  stabilityTone,
  stabilityTrend,
  stabilityVerdict,
  trendTone,
  TREND_WINDOW_MS,
  type Incident,
  type StabilityTrend,
} from "@/lib/ui/stability";
import { useRestartReading } from "./use-restarts";

export type StabilityApp = {
  id: string;
  status: string;
  statusChangedAt: Date | string | null;
  conditions: AppCondition[] | null;
  exitReason: ExitReason | null;
  createdAt: Date | string;
};

const TREND_DAYS = Math.round(TREND_WINDOW_MS / 86_400_000);

/** Clock the durations read against, refreshed on the same beat as RelativeTime. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Whether this app is stable now, whether it has been getting worse, and what
 * happened the last time it was not. Nothing here is newly measured — the
 * signals were already being collected and thrown away.
 */
export function AppStability({
  orgId,
  app,
  incidents,
}: {
  orgId: string;
  app: StabilityApp;
  /** Durable history, newest first. */
  incidents: Incident[];
}) {
  const restarts = useRestartReading(orgId, app.id);
  const now = useNow();

  const trend = stabilityTrend(incidents, now, app.createdAt);
  const verdict = stabilityVerdict({
    now,
    status: app.status,
    conditions: app.conditions,
    exitReason: app.exitReason,
    incidents,
    trend,
    restarts,
  });
  const held = heldFor(app.statusChangedAt, now);
  const faults = incidents.filter((i) => isFault(i.kind));
  const TrendIcon = trend.direction === "improving" ? TrendingDown : TrendingUp;

  return (
    <div className="space-y-6">
      <div className={`squircle rounded-lg border p-4 ${stabilitySurface(verdict.level)}`}>
        <div className="flex flex-wrap items-center gap-2">
          <Activity className={`size-4 shrink-0 ${stabilityTone(verdict.level)}`} aria-hidden="true" />
          <span className={`font-medium ${stabilityTone(verdict.level)}`}>{verdict.headline}</span>
          {held && <span className="text-xs text-muted-foreground">for {held}</span>}
        </div>
        {verdict.detail && <p className="mt-1.5 text-sm text-muted-foreground">{verdict.detail}</p>}
      </div>

      <dl className="flex flex-wrap gap-x-10 gap-y-4">
        <HeaderStat
          label="Restarts"
          hint="Docker's counter for the containers running now. Not history — replacing a container resets it to zero, so a deploy erases it. A count this container is still carrying keeps the verdict off Stable."
        >
          <span className={`tabular-nums ${restartTone(restarts)}`}>{restarts ? restarts.count : "—"}</span>
        </HeaderStat>
        <HeaderStat
          label={`Incidents · ${TREND_DAYS}d`}
          hint="Crashes, crash loops, failed deploys and rollbacks recorded for this app. These survive a deploy."
        >
          <span className={`flex items-center gap-1.5 ${trendTone(trend.direction)}`}>
            {showTrendIcon(trend) && <TrendIcon className="size-3.5" aria-hidden="true" />}
            <span className="tabular-nums">{trend.recent}</span>
          </span>
        </HeaderStat>
        <HeaderStat label="Last incident">
          {faults[0] ? (
            <RelativeTime date={new Date(faults[0].at)} />
          ) : (
            <span className="text-muted-foreground/50">None on record</span>
          )}
        </HeaderStat>
      </dl>

      {/* The trend label only earns a line when it says more than the zeros above. */}
      <p className="text-xs text-muted-foreground">
        {restartCaption(restarts, now)}.{trend.direction === "quiet" ? "" : ` ${trend.label}.`}
      </p>

      <div>
        <h3 className="type-label text-muted-foreground/60">History</h3>
        {incidents.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Nothing recorded. History starts when Vardo first saw this app, not when the container was built.
          </p>
        ) : (
          <ul className="mt-3 divide-y rounded-lg border">
            {incidents.map((incident) => (
              <li
                key={`${incident.kind}-${incident.at}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm"
              >
                <span className={`w-32 shrink-0 font-medium ${incidentTone(incident.kind)}`}>
                  {incidentLabel(incident.kind)}
                </span>
                <span className="min-w-0 flex-1 text-muted-foreground">{incident.detail}</span>
                <span className="text-xs text-muted-foreground/70">
                  <RelativeTime date={new Date(incident.at)} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function showTrendIcon(trend: StabilityTrend): boolean {
  return trend.direction === "improving" || trend.direction === "worsening";
}
