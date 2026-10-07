"use client";

import { useEffect, useState } from "react";
import { toast } from "@/lib/messenger";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/lib/metrics/format";
import { formatRelativeTime } from "@/lib/ui/relative-time";
import { deleteConfirmState } from "@/lib/ui/delete-app-confirm";
import type { BackupJob, RecentBackup } from "@/components/backups/types";

type Preview = {
  volumes: { name: string; sizeBytes: number | null }[];
  bindMounts: { path: string; sizeBytes: number | null }[];
  project: { id: string; name: string } | null;
};

type DeleteResult = {
  removedVolumes: string[];
  keptVolumes: string[];
  skippedVolumes: string[];
  keptPaths: string[];
};

type BackupStatus = { covered: boolean; lastAt: string | null };

async function fetchPreview<T>(orgId: string, appId: string, query = ""): Promise<T | null> {
  try {
    const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/delete-preview${query}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function fetchBackupStatus(orgId: string, appId: string): Promise<BackupStatus> {
  try {
    const res = await fetch(`/api/v1/organizations/${orgId}/backups?appId=${appId}`);
    if (!res.ok) return { covered: false, lastAt: null };
    const data: { jobs?: BackupJob[]; recentHistory?: RecentBackup[] } = await res.json();
    const covered = (data.jobs ?? []).some((job) =>
      job.backupJobApps.some((bja) => bja.app.id === appId),
    );
    const last = (data.recentHistory ?? [])
      .filter((b) => b.status === "success" && b.finishedAt)
      .map((b) => b.finishedAt as string)
      .sort()
      .at(-1);
    return { covered, lastAt: last ?? null };
  } catch {
    return { covered: false, lastAt: null };
  }
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function DeleteAppDialog({
  open,
  onOpenChange,
  orgId,
  app,
  noun = "app",
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  app: { id: string; name: string; displayName: string };
  noun?: "app" | "stack";
  onDeleted: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [deleteVolumes, setDeleteVolumes] = useState(false);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchPreview<Preview>(orgId, app.id).then((p) => {
      if (cancelled) return;
      setPreview(p);
      setPreviewFailed(p === null);
      if (!p || p.volumes.length + p.bindMounts.length === 0) return;
      // Sizes arrive later, or not at all.
      fetchPreview<Omit<Preview, "project">>(orgId, app.id, "?sizes=1").then((sized) => {
        if (cancelled || !sized) return;
        setPreview((prev) => (prev ? { ...prev, ...sized } : prev));
      });
    });
    fetchBackupStatus(orgId, app.id).then((b) => {
      if (!cancelled) setBackup(b);
    });
    return () => {
      cancelled = true;
    };
  }, [open, orgId, app.id]);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setPreview(null);
      setPreviewFailed(false);
      setBackup(null);
      setDeleteVolumes(false);
      setTyped("");
    }
  }

  const items = preview
    ? [
        ...preview.volumes.map((v) => ({ key: v.name, sizeBytes: v.sizeBytes })),
        ...preview.bindMounts.map((b) => ({ key: b.path, sizeBytes: b.sizeBytes })),
      ]
    : [];
  const loading = !preview && !previewFailed;
  const confirm = deleteConfirmState({
    preview: loading ? "loading" : previewFailed ? "failed" : "ready",
    hasData: items.length > 0,
    deleteVolumes,
    typed,
    appName: app.name,
    noun,
  });
  const needsTyping = confirm.deleteVolumes;
  const Noun = noun === "stack" ? "Stack" : "App";

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteVolumes: confirm.deleteVolumes }),
      });
      const data: Partial<DeleteResult> & { error?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to delete");
        return;
      }

      const removed = data.removedVolumes?.length ?? 0;
      const kept = (data.keptVolumes?.length ?? 0) + (data.keptPaths?.length ?? 0);
      toast.success(
        removed > 0
          ? `${Noun} and ${plural(removed, "volume")} deleted`
          : kept > 0
            ? `${Noun} deleted. Volumes kept.`
            : `${Noun} deleted`,
      );
      const skipped = data.skippedVolumes?.length ?? 0;
      if (skipped > 0) toast.warning(`${plural(skipped, "volume")} still in use and kept`);
      handleOpenChange(false);
      onDeleted();
    } catch {
      toast.error("Failed to delete");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={`Delete ${app.displayName}`}
      description={`Removes its ${noun === "stack" ? "services, " : ""}environments, deployments, domains and variables. This can't be undone.`}
      onConfirm={handleDelete}
      loading={deleting}
      confirmLabel={confirm.label}
      confirmDisabled={confirm.disabled}
    >
      <div className="space-y-4 text-sm">
        {preview?.project && (
          <p>
            Also deletes the project <span className="font-medium">{preview.project.name}</span>,
            which has no other apps.
          </p>
        )}

        {loading && <p className="text-muted-foreground">Checking for volumes…</p>}
        {previewFailed && (
          <p className="text-muted-foreground">Couldn&apos;t list volumes. They&apos;ll be kept.</p>
        )}
        {preview && items.length === 0 && <p className="text-muted-foreground">No volumes.</p>}

        {items.length > 0 && (
          <div className="space-y-2">
            <label className="flex cursor-pointer select-none items-center gap-3">
              <Checkbox
                checked={deleteVolumes}
                onCheckedChange={(checked) => {
                  setDeleteVolumes(checked === true);
                  setTyped("");
                }}
              />
              <span className="font-medium">Also delete volumes</span>
            </label>
            <ul className="squircle max-h-48 divide-y overflow-y-auto rounded-md border">
              {items.map((item) => (
                <li key={item.key} className="flex items-center justify-between gap-3 px-3 py-1.5">
                  <span className="min-w-0 truncate font-mono text-xs" title={item.key}>
                    {item.key}
                  </span>
                  {item.sizeBytes !== null && (
                    <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                      {formatBytes(item.sizeBytes)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {!deleteVolumes && (
              <p className="text-muted-foreground">Unchecked, they stay on the server.</p>
            )}
          </div>
        )}

        {backup && (
          <p className="text-muted-foreground">
            {backup.covered && backup.lastAt
              ? `Last backup: ${formatRelativeTime(backup.lastAt)}`
              : "No backup"}
          </p>
        )}

        {needsTyping && (
          <div className="space-y-1.5">
            <label htmlFor="delete-app-confirm" className="block">
              Type <span className="font-mono font-medium">{app.name}</span> to delete its volumes
            </label>
            <Input
              id="delete-app-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </div>
        )}
      </div>
    </ConfirmDeleteDialog>
  );
}
