"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Database, Folder, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { toast } from "@/lib/messenger";
import { formatBytes } from "@/lib/metrics/format";

type Row = {
  kind: "volume" | "dir";
  name: string;
  sourceApp: string;
  location: string;
  sizeBytes: number | null;
};

type Listing = {
  volumes: { name: string; sourceApp: string; sizeBytes: number | null }[];
  dirs: { name: string; path: string; sizeBytes: number | null }[];
};

const ENDPOINT = "/api/v1/admin/maintenance/detached-volumes";

function toRows(data: Listing): Row[] {
  return [
    ...data.volumes.map((v) => ({
      kind: "volume" as const,
      name: v.name,
      sourceApp: v.sourceApp,
      location: v.name,
      sizeBytes: v.sizeBytes,
    })),
    ...data.dirs.map((d) => ({
      kind: "dir" as const,
      name: d.name,
      sourceApp: d.name,
      location: d.path.split("/").slice(-2).join("/"),
      sizeBytes: d.sizeBytes,
    })),
  ];
}

async function fetchListing(url: string): Promise<Row[] | null> {
  try {
    const res = await fetch(url);
    return res.ok ? toRows(await res.json()) : null;
  } catch {
    return null;
  }
}

export function DetachedVolumesCard() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [target, setTarget] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    async function load() {
      const names = await fetchListing(ENDPOINT);
      setFailed(names === null);
      setRows(names);
      if (!names?.length) return;

      // Sizes take a while on hosts with many volumes, so they arrive second.
      setMeasuring(true);
      const sized = await fetchListing(`${ENDPOINT}?sizes=1`);
      if (sized) setRows(sized);
      setMeasuring(false);
    }

    void load();
  }, []);

  async function handleDelete() {
    if (!target) return;
    setDeleting(true);
    try {
      const res = await fetch(`${ENDPOINT}/${encodeURIComponent(target.name)}?kind=${target.kind}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't delete it");
        return;
      }
      toast.success(`Deleted ${target.name}`);
      setRows((current) => current?.filter((r) => !(r.kind === target.kind && r.name === target.name)) ?? null);
    } catch {
      toast.error("Couldn't delete it");
    } finally {
      setDeleting(false);
      setTarget(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="size-4" aria-hidden="true" />
          Detached volumes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Deleting an app keeps its volumes and bind-mounted data by default. These are left over
          from apps that no longer exist. Compose names volumes after the app, so creating an app
          with the same name reattaches them. Deleting one here removes it for good.
        </p>

        {rows === null && !failed ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Looking for detached volumes...
          </div>
        ) : failed ? (
          <div className="flex items-center gap-2 text-sm text-status-warning">
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            Couldn&apos;t list volumes. Is Docker running?
          </div>
        ) : rows!.length === 0 ? (
          <p className="text-sm text-muted-foreground">No detached volumes.</p>
        ) : (
          <ul aria-label="Detached volumes" className="divide-y rounded-md bg-background-deep">
            {rows!.map((row) => (
              <li key={`${row.kind}:${row.name}`} className="flex items-center gap-3 px-3 py-2">
                {row.kind === "volume" ? (
                  <Database className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm font-medium" title={row.location}>{row.location}</p>
                  <p className="text-xs text-muted-foreground">
                    From <span className="font-medium">{row.sourceApp}</span>
                    {row.kind === "dir" ? " · Bind-mounted data" : ""}
                  </p>
                </div>
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                  {row.sizeBytes !== null ? (
                    formatBytes(row.sizeBytes)
                  ) : measuring ? (
                    <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-label="Measuring" />
                  ) : (
                    "Size unknown"
                  )}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Delete ${row.location}`}
                  onClick={() => setTarget(row)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <AlertDialog open={target !== null} onOpenChange={(open) => !open && !deleting && setTarget(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {target?.location}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the {target?.kind === "dir" ? "directory and its data" : "volume and its data"} from{" "}
              {target?.sourceApp}. It can&apos;t be undone. Nothing else is touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
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
