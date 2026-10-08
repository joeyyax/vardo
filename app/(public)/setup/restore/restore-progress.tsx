"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpToLine, Clock, Loader2 } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/lib/messenger";
import type { RestoreView } from "@/lib/restore/queue";
import { formatTakenAt } from "./choose-backup";

type App = NonNullable<RestoreView>["apps"][number];

const STATUS: Record<App["status"], { label: string; variant: BadgeProps["variant"] }> = {
  queued: { label: "Queued", variant: "neutral" },
  restoring: { label: "Restoring", variant: "info" },
  deploying: { label: "Deploying", variant: "info" },
  done: { label: "Done", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  deferred: { label: "Restore later", variant: "outline" },
};

/** Newest archive date across an app's volumes, for the plan column. */
function archivesAt(app: App): string | null {
  if (app.archives.length === 0) return null;
  return app.archives.map((a) => a.finishedAt).sort().at(-1)!;
}

export function RestoreProgressView({ restore, onChange }: { restore: NonNullable<RestoreView>; onChange: () => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const { progress } = restore;
  const finished = restore.status === "finished";
  const failed = restore.apps.filter((a) => a.status === "failed");
  const percent = progress.total === 0 ? 100 : Math.round((progress.settled / progress.total) * 100);

  async function act(appId: string, action: "front" | "defer" | "requeue") {
    setPending(appId);
    try {
      const res = await fetch(`/api/setup/restore/apps/${appId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Couldn't update the queue");
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the queue");
    } finally {
      setPending(null);
    }
  }

  async function resume() {
    setPending("resume");
    try {
      const res = await fetch("/api/setup/restore/resume", { method: "POST" });
      if (!res.ok) throw new Error();
      const { backups, crons } = await res.json();
      toast.success(`Resumed ${backups} backup job${backups === 1 ? "" : "s"} and ${crons} cron job${crons === 1 ? "" : "s"}`);
      onChange();
    } catch {
      toast.error("Couldn't resume backups");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-medium">
              {finished ? "Restore finished" : "Restoring apps"}
            </h2>
            <span className="text-sm tabular-nums text-muted-foreground">
              {progress.settled} of {progress.total} apps
            </span>
          </div>
          <CardDescription>
            From the system backup taken {formatTakenAt(restore.systemBackupAt)}.
            {progress.active > 0 && ` ${progress.active} in progress.`}
            {progress.failed > 0 && ` ${progress.failed} failed.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Progress value={percent} aria-label={`${progress.settled} of ${progress.total} apps restored`} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <ul className="divide-y">
            {restore.apps.map((app) => {
              const at = archivesAt(app);
              const s = STATUS[app.status];
              const busy = app.status === "restoring" || app.status === "deploying";
              return (
                <li key={app.appId} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{app.name}</span>
                      {app.priority !== "standard" && (
                        <Badge variant={app.priority === "critical" ? "critical" : "disposable"}>{app.priority}</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {at ? `Data from ${formatTakenAt(at)}` : "No archives, redeploy only"}
                      {!app.redeploy && " · stays stopped, as in the backup"}
                    </p>
                    {app.error && app.status === "failed" && (
                      <p className="mt-1 text-xs text-status-error">{app.error}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {app.status === "queued" && (
                      <>
                        <Button size="xs" variant="ghost" disabled={pending !== null} onClick={() => act(app.appId, "front")}>
                          <ArrowUpToLine /> Move to front
                        </Button>
                        <Button size="xs" variant="ghost" disabled={pending !== null} onClick={() => act(app.appId, "defer")}>
                          <Clock /> Restore later
                        </Button>
                      </>
                    )}
                    {app.status === "deferred" && (
                      <Button size="xs" variant="ghost" disabled={pending !== null} onClick={() => act(app.appId, "front")}>
                        Restore now
                      </Button>
                    )}
                    <Badge variant={s.variant}>
                      {busy && <Loader2 className="mr-1 size-3 animate-spin" aria-hidden />}
                      {s.label}
                    </Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      {finished && failed.length > 0 && (
        <Callout variant="error" label={`${failed.length} app${failed.length === 1 ? "" : "s"} didn't restore`}>
          <ul className="mt-1 space-y-1">
            {failed.map((a) => (
              <li key={a.appId}>
                <span className="font-medium">{a.name}</span>: {a.error}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <Card>
        <CardHeader>
          <h2 className="font-medium">Resume backups</h2>
          <CardDescription>
            {restore.resumedAt
              ? `Resumed ${formatTakenAt(restore.resumedAt)}.`
              : `${restore.pausedBackupJobs} backup job${restore.pausedBackupJobs === 1 ? "" : "s"} and ${restore.pausedCronJobs} cron job${restore.pausedCronJobs === 1 ? "" : "s"} are paused. Resume them once the old instance is off, or both write to the same bucket.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {!restore.resumedAt && (
            <Button onClick={resume} disabled={pending !== null}>
              {pending === "resume" && <Loader2 className="animate-spin" />}
              Resume backups and cron jobs
            </Button>
          )}
          {finished && (
            <Button asChild variant="outline">
              <Link href="/projects">Go to projects</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
