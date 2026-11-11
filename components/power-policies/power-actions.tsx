"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { formatRelativeTime } from "@/lib/ui/relative-time";
import type { PowerActionKind } from "@/lib/db/schema/power";

const REFRESH_MS = 15_000;

type Action = { id: string; kind: PowerActionKind; title: string; message: string; notified: boolean; createdAt: string };
type Stopped = { appId: string; name: string; stoppedAt: string };

const TONE: Record<PowerActionKind, StatusDotTone> = {
  "backups-skipped": "warn",
  "deploys-held": "warn",
  "deploy-override": "neutral",
  "apps-stopped": "warn",
  "apps-restarted": "good",
};

/** The power policies' recent actions, newest first, and the apps still stopped for power. */
export function PowerActions() {
  const [actions, setActions] = useState<Action[] | null>(null);
  const [stopped, setStopped] = useState<Stopped[]>([]);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/v1/admin/power/actions")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { actions: Action[]; stopped: Stopped[] } | null) => {
          if (!live || !data) return;
          setActions(data.actions);
          setStopped(data.stopped);
          setNow(Date.now());
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (!actions) return null;

  return (
    <section className="space-y-3" aria-labelledby="power-actions-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="power-actions-heading" className="type-h3">Recent actions</h3>
        <Link href="/admin/settings/power" className="text-xs text-muted-foreground hover:text-foreground">
          Power policies
        </Link>
      </div>

      {stopped.length > 0 && (
        <p className="text-sm text-status-warning">
          Stopped for power: {stopped.map((s) => s.name).join(", ")}. They restart once power has been back for 2 minutes.
        </p>
      )}

      {actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No policy has acted yet. Skipped backups, held deploys and stopped apps show here.</p>
      ) : (
        <Card variant="surface" className="divide-y">
          <ol>
            {actions.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-4 px-5 py-3">
                <div className="min-w-0 space-y-0.5">
                  <StatusDot tone={TONE[a.kind]}>
                    <span className="text-sm font-medium">{a.title}</span>
                  </StatusDot>
                  <p className="text-xs text-muted-foreground">{a.message}</p>
                </div>
                <time dateTime={a.createdAt} className="shrink-0 text-xs text-muted-foreground tabular-nums" title={new Date(a.createdAt).toLocaleString()}>
                  {now ? formatRelativeTime(a.createdAt, new Date(now)) : ""}
                </time>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </section>
  );
}
