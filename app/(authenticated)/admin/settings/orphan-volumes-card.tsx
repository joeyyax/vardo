"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, HardDrive, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, cardVariants } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/messenger";
import { formatBytes } from "@/lib/metrics/format";

type Volume = {
  name: string;
  kind: "anonymous" | "unclaimed";
  project: string | null;
  createdAt: string | null;
  sizeBytes: number | null;
};

const ENDPOINT = "/api/v1/admin/maintenance/orphan-volumes";

const KIND_COPY: Record<Volume["kind"], string> = {
  anonymous: "Anonymous: no container will reattach it",
  unclaimed: "Named, but no Vardo app claims it",
};

async function fetchVolumes(url: string): Promise<Volume[] | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()).volumes as Volume[]) : null;
  } catch {
    return null;
  }
}

function shortName(name: string): string {
  return /^[0-9a-f]{64}$/.test(name) ? `${name.slice(0, 12)}…` : name;
}

export function OrphanVolumesCard() {
  const [volumes, setVolumes] = useState<Volume[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targets, setTargets] = useState<string[] | null>(null);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    async function load() {
      const names = await fetchVolumes(ENDPOINT);
      setFailed(names === null);
      setVolumes(names);
      if (!names?.length) return;
      setMeasuring(true);
      const sized = await fetchVolumes(`${ENDPOINT}?sizes=1`);
      if (sized) setVolumes(sized);
      setMeasuring(false);
    }
    void load();
  }, []);

  const total = useMemo(() => {
    const sizes = (volumes ?? []).map((v) => v.sizeBytes);
    return sizes.some((s) => s !== null) ? sizes.reduce<number>((sum, s) => sum + (s ?? 0), 0) : null;
  }, [volumes]);

  function toggle(name: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  function openConfirm(names: string[]) {
    setTyped("");
    setTargets(names);
  }

  const confirmWord = targets && targets.length > 1 ? `delete ${targets.length}` : "delete";

  async function handleDelete() {
    if (!targets) return;
    setDeleting(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: targets, confirm: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't delete");
        return;
      }
      const results = data.results as { name: string; ok: boolean; error?: string }[];
      const removed = new Set(results.filter((r) => r.ok).map((r) => r.name));
      const refused = results.filter((r) => !r.ok);
      if (removed.size > 0) toast.success(removed.size === 1 ? "Deleted 1 volume" : `Deleted ${removed.size} volumes`);
      if (refused.length > 0) toast.error(`Kept ${refused.length}: ${refused[0].error ?? "refused"}`);
      setVolumes((current) => current?.filter((v) => !removed.has(v.name)) ?? null);
      setSelected((current) => new Set([...current].filter((n) => !removed.has(n))));
    } catch {
      toast.error("Couldn't delete");
    } finally {
      setDeleting(false);
      setTargets(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="size-4" aria-hidden="true" />
          Unused volumes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          No container mounts these and no Vardo app, volume or compose file names them. They may still hold data
          from an old run or from something outside Vardo, so cleanup never removes them. Deleting one is permanent.
        </p>

        {volumes === null && !failed ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Looking for unused volumes...
          </div>
        ) : failed ? (
          <div className="flex items-center gap-2 text-sm text-status-warning">
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            Couldn&apos;t list volumes. Is Docker running?
          </div>
        ) : volumes!.length === 0 ? (
          <p className="text-sm text-muted-foreground">No unused volumes.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm tabular-nums">
                {volumes!.length === 1 ? "1 volume" : `${volumes!.length} volumes`}
                {total !== null ? `, ${formatBytes(total)}` : measuring ? ", measuring..." : ""}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={selected.size === 0}
                onClick={() => openConfirm([...selected])}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Delete selected{selected.size > 0 ? ` (${selected.size})` : ""}
              </Button>
            </div>
            <ul aria-label="Unused volumes" className={cn(cardVariants({ variant: "inset" }), "max-h-96 divide-y overflow-y-auto rounded-md")}>
              {volumes!.map((v) => (
                <li key={v.name} className="flex items-center gap-3 px-3 py-2">
                  <Checkbox
                    aria-label={`Select ${v.name}`}
                    checked={selected.has(v.name)}
                    onCheckedChange={(on) => toggle(v.name, on === true)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm font-medium" title={v.name}>{shortName(v.name)}</p>
                    <p className="text-xs text-muted-foreground">
                      {KIND_COPY[v.kind]}
                      {v.project ? ` · Project ${v.project}` : ""}
                      {v.createdAt ? ` · Created ${new Date(v.createdAt).toLocaleDateString()}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                    {v.sizeBytes !== null ? (
                      formatBytes(v.sizeBytes)
                    ) : measuring ? (
                      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-label="Measuring" />
                    ) : (
                      "Size unknown"
                    )}
                  </span>
                  <Button variant="outline" size="sm" aria-label={`Delete ${v.name}`} onClick={() => openConfirm([v.name])}>
                    <Trash2 className="size-4" aria-hidden="true" />
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>

      <AlertDialog open={targets !== null} onOpenChange={(open) => !open && !deleting && setTargets(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {targets?.length === 1 ? `Delete ${shortName(targets[0])}?` : `Delete ${targets?.length} volumes?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Their data is gone for good. Vardo checks each one again first and keeps any that came into use.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="orphan-confirm">Type {confirmWord} to confirm</Label>
            <Input id="orphan-confirm" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting || typed.trim() !== confirmWord}
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
            >
              {deleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
