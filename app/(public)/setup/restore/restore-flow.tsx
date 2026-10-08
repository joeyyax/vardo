"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import type { RestoreStatus } from "@/lib/restore/status";
import { ChooseBackup } from "./choose-backup";
import { RestoreProgressView } from "./restore-progress";

const POLL_MS = 3_000;

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Polls the restore's state, so a reload or a console restart lands back on the right step. */
export function RestoreFlow() {
  const [status, setStatus] = useState<RestoreStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/setup/restore", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setStatus((await res.json()) as RestoreStatus);
      setUnreachable(false);
    } catch {
      // The console restarts mid-restore; keep polling.
      setUnreachable(true);
    }
  }, []);

  useEffect(() => {
    // Polls an external system; the first fetch lands on a timer so state isn't set during the effect.
    const first = setTimeout(refresh, 0);
    // Nothing changes on its own while the operator is filling in the form.
    const idle = status?.phase === "choose" || status?.phase === "database-failed";
    const timer = idle ? undefined : setInterval(refresh, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh, status?.phase]);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
      {status?.phase === "choose" && (
        <Link
          href="/setup"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Set up as new instead
        </Link>
      )}
      <div className="mb-6">
        <h1 className="type-h2">Restore from backup</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The database comes back first, then each app with its data.
        </p>
      </div>
      {unreachable && (
        <Callout variant="warning" className="mb-4">
          Can&apos;t reach Vardo right now. It may be restarting. This page keeps trying.
        </Callout>
      )}
      {!status ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      ) : (
        <Phase status={status} onChange={refresh} />
      )}
    </div>
  );
}

function Phase({ status, onChange }: { status: RestoreStatus; onChange: () => void }) {
  switch (status.phase) {
    case "choose":
      return <ChooseBackup configuredTarget={status.configuredTarget} onStarted={onChange} />;
    case "database":
      return (
        <Card>
          <CardHeader>
            <h2 className="font-medium">Restoring Vardo&apos;s database</h2>
            <CardDescription>
              {status.systemBackupKey
                ? `From ${status.systemBackupKey}. Apps restore once this is done.`
                : "A restore started in another browser is running."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Restoring" />
          </CardContent>
        </Card>
      );
    case "database-failed":
      return (
        <div className="space-y-4">
          <Callout variant="error" label="Database restore failed">
            {sentence(status.error ?? "The database restore failed")}{" "}
            {status.changed
              ? "The backup's data is in, but a step after it failed. Check the log, then restart Vardo. It finishes the migrations and moves on to the apps."
              : "This instance's database wasn't changed."}
          </Callout>
          {status.log && (
            <details className="squircle rounded-lg border p-3 text-xs">
              <summary className="cursor-pointer text-sm">Restore log</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono">{status.log}</pre>
            </details>
          )}
          {!status.changed && <ChooseBackup configuredTarget={status.configuredTarget} onStarted={onChange} />}
        </div>
      );
    case "apps":
      if (status.signIn) {
        return (
          <Card>
            <CardHeader>
              <h2 className="font-medium">Vardo&apos;s database is back</h2>
              <CardDescription>
                Sign in with an admin account from the backup to follow the apps as they restore.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link href="/login?callbackUrl=/setup/restore">Sign in</Link>
              </Button>
            </CardContent>
          </Card>
        );
      }
      return <RestoreProgressView restore={status.restore} onChange={onChange} />;
    case "none":
      return (
        <Card>
          <CardHeader>
            <h2 className="font-medium">No restore to show</h2>
            <CardDescription>This instance is already set up, and no restore has run on it.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/projects">Go to projects</Link>
            </Button>
          </CardContent>
        </Card>
      );
  }
}
