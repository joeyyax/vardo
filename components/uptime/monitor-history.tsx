"use client";

import Link from "next/link";
import { formatWhen } from "@/lib/uptime/core/range";
import { formatDuration } from "@/lib/uptime/format";
import type { MonitorDetail, OutageView } from "@/lib/uptime/types";
import { ResponseChart } from "./response-chart";
import { useUptimeTimeZone } from "./time-zone";


/** Outages from the last 14 days, newest first. */
export function OutageList({ outages }: { outages: OutageView[] }) {
  const timeZone = useUptimeTimeZone();
  if (outages.length === 0) return <p className="text-sm text-muted-foreground">No outages in the last 14 days.</p>;
  return (
    <ul className="divide-y">
      {outages.map((o) => (
        <li key={o.start} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
          <span>
            {formatWhen(o.start, timeZone)} · {o.end ? `${formatDuration(o.durationMs)}` : `ongoing for ${formatDuration(o.durationMs)}`}
          </span>
          {o.incidentId && (
            <Link href="/activity" className="text-primary hover:underline">
              Open the incident
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The response chart and outages of one monitor, for a row that expands in place. */
export function MonitorHistory({ detail }: { detail: MonitorDetail }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <h3 className="text-sm font-medium">Response time</h3>
        <ResponseChart series={detail.latency24h} height={160} />
      </div>
      <div className="grid gap-2">
        <h3 className="text-sm font-medium">Outages</h3>
        <OutageList outages={detail.outages} />
      </div>
    </div>
  );
}
