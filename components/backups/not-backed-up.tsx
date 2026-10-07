"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatBytes } from "@/lib/metrics/format";
import { toast } from "@/lib/messenger";
import type { UncoveredApp } from "@/lib/backups/enroll";
import type { BackupTarget } from "./types";

type Coverage = { apps: UncoveredApp[]; defaultTargetId: string | null };

function AppRow({
  app,
  orgId,
  targets,
  defaultTargetId,
  onDone,
}: {
  app: UncoveredApp;
  orgId: string;
  targets: BackupTarget[];
  defaultTargetId: string | null;
  onDone: () => void;
}) {
  const [targetId, setTargetId] = useState(defaultTargetId ?? targets[0]?.id ?? "");
  const [chosen, setChosen] = useState(
    () => new Set(app.volumes.filter((v) => v.verdict === "include" || v.selected).map((v) => v.id)),
  );
  const [saving, setSaving] = useState(false);

  async function optIn() {
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/backups/coverage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: app.id, targetId, volumeIds: [...chosen] }),
      });
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? "Couldn't turn on backups");
        return;
      }
      toast.success(`Backing up ${app.displayName ?? app.name}`);
      onDone();
    } catch {
      toast.error("Couldn't turn on backups");
    } finally {
      setSaving(false);
    }
  }

  function toggle(id: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <li className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{app.displayName ?? app.name}</span>
          {app.status === "partial" && <Badge variant="warning">Partly backed up</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <Select value={targetId} onValueChange={setTargetId}>
            <SelectTrigger className="h-8 w-44" aria-label="Storage target">
              <SelectValue placeholder="Target" />
            </SelectTrigger>
            <SelectContent>
              {targets.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name} ({t.type})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={optIn} disabled={saving || !targetId || chosen.size === 0}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Back up
          </Button>
        </div>
      </div>
      <ul className="space-y-1.5 text-sm">
        {app.volumes.map((v) => {
          const excluded = v.verdict === "exclude";
          const id = `vol-${v.id}`;
          return (
            <li key={v.id} className={`flex items-start gap-2 ${excluded ? "text-muted-foreground" : ""}`}>
              {excluded ? (
                <span className="size-4 shrink-0" />
              ) : (
                <Checkbox id={id} checked={chosen.has(v.id)} onCheckedChange={() => toggle(v.id)} className="mt-0.5" />
              )}
              <label htmlFor={excluded ? undefined : id} className="min-w-0 flex-1">
                <span className="break-all font-mono text-xs">{v.source ?? v.name}</span>
                <span className="text-muted-foreground"> → {v.mountPath}</span>
                <span className="block text-xs text-muted-foreground">
                  {v.sizeBytes !== null && `${formatBytes(v.sizeBytes)} · `}
                  {v.reason}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/** Apps whose state no job captures, each opted in with one action. */
export function NotBackedUp({
  orgId,
  targets,
  heading,
  onChanged,
}: {
  orgId: string;
  targets: BackupTarget[];
  heading: "h2" | "h3";
  onChanged: () => void;
}) {
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/organizations/${orgId}/backups/coverage`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Coverage | null) => {
        if (!cancelled) setCoverage(data ?? { apps: [], defaultTargetId: null });
      })
      .catch(() => {
        if (!cancelled) setCoverage({ apps: [], defaultTargetId: null });
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, reload]);

  if (coverage && coverage.apps.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle as={heading}>Not backed up</CardTitle>
        <p className="text-sm text-muted-foreground">
          Apps with data no job captures. Volumes over 10 GB and model stores are unchecked.
        </p>
      </CardHeader>
      <CardContent>
        {!coverage ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Measuring volumes
          </div>
        ) : targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">Add a storage target to back these up.</p>
        ) : (
          <ul className="divide-y">
            {coverage.apps.map((app) => (
              <AppRow
                key={app.id}
                app={app}
                orgId={orgId}
                targets={targets}
                defaultTargetId={coverage.defaultTargetId}
                onDone={() => {
                  setReload((n) => n + 1);
                  onChanged();
                }}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
