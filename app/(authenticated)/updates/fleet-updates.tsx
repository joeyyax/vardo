"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BellOff, ChevronDown, CircleCheck, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  MigrationDialog,
  type MigrationPrompt,
} from "@/components/image-updates/migration-dialog";
import { IgnoreMenu, type IgnoreChoice } from "@/components/image-updates/ignore-menu";
import { SelfManagedUpdates } from "@/components/image-updates/self-managed-updates";
import {
  UpdateRow,
  UpdateRowHeader,
  defaultTarget,
  type ServiceUpdate,
} from "@/components/image-updates/update-row";
import { toast } from "@/lib/messenger";
import { requiresMigration } from "@/lib/docker/image-updates/migration-path";
import { rowKey, type BatchReport } from "@/lib/docker/image-updates/batch-report";
import { describeRule } from "@/lib/docker/image-updates/ignore";
import type {
  FleetAppUpdates,
  FleetIgnoredUpdate,
  FleetUpdateStatus,
} from "@/lib/docker/image-updates/status";

/** Acknowledgements are tied to the tag they were given for. */
function ackKey(appId: string, service: string | null, tag: string): string {
  return `${rowKey(appId, service)}@${tag}`;
}

export function FleetUpdates({ orgId }: { orgId: string }) {
  const [data, setData] = useState<FleetUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [migration, setMigration] = useState<MigrationPrompt | null>(null);
  /** Set when the migration dialog was opened by a checkbox rather than a button. */
  const [migrationSelects, setMigrationSelects] = useState(false);
  const [report, setReport] = useState<BatchReport | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/image-updates?detail=services`);
      setData(res.ok ? await res.json() : null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const rows = useMemo(
    () =>
      (data?.apps ?? []).flatMap((app) =>
        app.services.map((entry) => ({ app, entry, key: rowKey(app.appId, entry.service) })),
      ),
    [data],
  );

  function targetFor(appId: string, entry: ServiceUpdate): string | null {
    return defaultTarget(entry, chosen[rowKey(appId, entry.service)]);
  }

  function isBlocked(appId: string, entry: ServiceUpdate): boolean {
    const tag = targetFor(appId, entry);
    if (!requiresMigration(entry.image, entry.currentTag, tag)) return false;
    return !acknowledged.has(ackKey(appId, entry.service, tag!));
  }

  const blockedCount = rows.filter((row) => isBlocked(row.app.appId, row.entry)).length;
  const selectable = rows.filter((row) => !isBlocked(row.app.appId, row.entry));
  const allSelected = selectable.length > 0 && selectable.every((row) => selected.has(row.key));

  function toggleRow(app: FleetAppUpdates, entry: ServiceUpdate, next: boolean) {
    const key = rowKey(app.appId, entry.service);
    if (next && isBlocked(app.appId, entry)) {
      setMigrationSelects(true);
      setMigration({
        appId: app.appId,
        appName: app.displayName,
        entry,
        tag: targetFor(app.appId, entry)!,
      });
      return;
    }
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(key);
      else copy.delete(key);
      return copy;
    });
  }

  function toggleAll(next: boolean) {
    setSelected(next ? new Set(selectable.map((row) => row.key)) : new Set());
  }

  function acknowledge(prompt: MigrationPrompt) {
    const key = ackKey(prompt.appId, prompt.entry.service, prompt.tag);
    setAcknowledged((prev) => new Set(prev).add(key));
    setMigration(null);
    if (migrationSelects) {
      setSelected((prev) => new Set(prev).add(rowKey(prompt.appId, prompt.entry.service)));
    } else {
      applyOne(prompt.appId, prompt.entry, prompt.tag, true);
    }
  }

  async function ignore(app: FleetAppUpdates, entry: ServiceUpdate, choice: IgnoreChoice) {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/image-updates/ignores`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: app.appId, service: entry.service, ...choice }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not ignore that update");
      setSelected((prev) => {
        const copy = new Set(prev);
        copy.delete(rowKey(app.appId, entry.service));
        return copy;
      });
      toast.success(
        `Ignoring ${choice.scope === "major" ? "majors" : "updates"} for ${entry.service ?? app.displayName}`,
      );
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not ignore that update");
    }
  }

  async function unignore(entry: FleetIgnoredUpdate) {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/image-updates/ignores`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: entry.appId, service: entry.service.service }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not restore that update");
      toast.success(`${entry.service.service ?? entry.displayName} is back in the list`);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not restore that update");
    }
  }

  async function check() {
    setChecking(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/image-updates`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Check failed");
      toast.success(`Checked ${body.checked} image${body.checked === 1 ? "" : "s"}`);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Check failed");
    } finally {
      setChecking(false);
    }
  }

  async function applyOne(
    appId: string,
    entry: ServiceUpdate,
    tag: string,
    acknowledgeMigration = false,
  ) {
    setBusyRow(rowKey(appId, entry.service));
    setReport(null);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/image-updates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          service: entry.service,
          tag,
          ...(acknowledgeMigration ? { acknowledgeMigration: true } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Update failed");
      toast.success(`Pinned ${entry.service ?? "image"} to ${tag}`);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Update failed");
    } finally {
      setBusyRow(null);
    }
  }

  function onRowApply(app: FleetAppUpdates, entry: ServiceUpdate) {
    const tag = targetFor(app.appId, entry);
    if (!tag) return;
    if (isBlocked(app.appId, entry)) {
      setMigrationSelects(false);
      setMigration({ appId: app.appId, appName: app.displayName, entry, tag });
      return;
    }
    applyOne(app.appId, entry, tag, requiresMigration(entry.image, entry.currentTag, tag));
  }

  async function applySelected() {
    const updates = rows
      .filter((row) => selected.has(row.key))
      .map((row) => {
        const tag = targetFor(row.app.appId, row.entry)!;
        return {
          appId: row.app.appId,
          service: row.entry.service,
          tag,
          ...(requiresMigration(row.entry.image, row.entry.currentTag, tag)
            ? { acknowledgeMigration: true }
            : {}),
        };
      })
      .filter((update) => update.tag);

    if (updates.length === 0) return;

    setApplying(true);
    setReport(null);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/image-updates/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const body = await res.json();
      if (res.status === 400 || res.status === 403 || res.status === 429) {
        throw new Error(body.error ?? "Batch update failed");
      }
      const result = body as BatchReport;
      setReport(result);
      if (result.failed === 0) toast.success(result.message);
      else if (result.applied === 0) toast.error(result.message);
      else toast.warning(result.message);
      setSelected(new Set());
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Batch update failed");
    } finally {
      setApplying(false);
    }
  }

  if (loading) {
    return <p className="type-body-sm text-muted-foreground">Reading update status…</p>;
  }

  if (!data) {
    return (
      <p className="type-body-sm text-status-error">Could not read update status for this org.</p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 type-body-sm text-muted-foreground">
          <Checkbox
            checked={allSelected}
            disabled={selectable.length === 0 || applying}
            onCheckedChange={(value) => toggleAll(value === true)}
            aria-label="Select every update that needs no migration"
          />
          Select all
        </label>
        <span className="type-body-sm text-muted-foreground">
          {data.totalUpdates} update{data.totalUpdates === 1 ? "" : "s"} across {data.apps.length}{" "}
          app{data.apps.length === 1 ? "" : "s"}
          {blockedCount > 0 && ` · ${blockedCount} need review`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={checking} onClick={check}>
            <RefreshCw className={checking ? "animate-spin" : undefined} aria-hidden="true" />
            {checking ? "Checking…" : "Check now"}
          </Button>
          <Button size="sm" disabled={selected.size === 0 || applying} onClick={applySelected}>
            {applying ? "Applying…" : `Update selected${selected.size ? ` (${selected.size})` : ""}`}
          </Button>
        </div>
      </div>

      {data.cooldownUntil && (
        <p className="type-body-sm text-status-warning">
          Registry checks are paused until {new Date(data.cooldownUntil).toLocaleTimeString()} after
          a rate limit. Counts below may be out of date.
        </p>
      )}

      {report && <BatchOutcome report={report} />}

      {data.apps.length === 0 && data.selfManaged.length === 0 ? (
        <section className="squircle rounded-lg border bg-card px-4 py-10 text-center">
          <CircleCheck className="mx-auto size-6 text-status-success" aria-hidden="true" />
          <p className="type-body mt-2 text-muted-foreground">
            Every image across the fleet is up to date.
          </p>
          {data.unknownCount > 0 && (
            <p className="type-body-sm mt-1 text-muted-foreground/70">
              {data.unknownCount} image{data.unknownCount === 1 ? "" : "s"} could not be checked.
            </p>
          )}
        </section>
      ) : (
        data.apps.map((app) => (
          <section
            key={app.appId}
            aria-label={`Image updates for ${app.displayName}`}
            className="squircle rounded-lg border bg-card divide-y"
          >
            <header className="flex items-center gap-2 px-4 py-2.5">
              <Link
                href={`/apps/${app.name}/updates`}
                className="type-label text-foreground underline-offset-2 hover:underline"
              >
                {app.displayName}
              </Link>
              <span className="type-label text-muted-foreground/50">
                {app.updateCount} update{app.updateCount === 1 ? "" : "s"}
              </span>
            </header>

            <UpdateRowHeader selectable />

            {app.services.map((entry) => {
              const key = rowKey(app.appId, entry.service);
              return (
                <UpdateRow
                  key={key}
                  entry={entry}
                  target={targetFor(app.appId, entry)}
                  onTargetChange={(tag) => {
                    setChosen((prev) => ({ ...prev, [key]: tag }));
                    // The pick changed, so any acknowledgement of the old one is void.
                    setSelected((prev) => {
                      const copy = new Set(prev);
                      copy.delete(key);
                      return copy;
                    });
                  }}
                  onApply={() => onRowApply(app, entry)}
                  applying={busyRow === key}
                  disabled={applying}
                  selected={selected.has(key)}
                  onSelectedChange={(next) => toggleRow(app, entry, next)}
                  selectLabel={`Select ${entry.service ?? entry.image} on ${app.displayName}`}
                  ignoreSlot={
                    <IgnoreMenu
                      label={`${entry.service ?? entry.image} on ${app.displayName}`}
                      disabled={applying}
                      onChoose={(choice) => ignore(app, entry, choice)}
                    />
                  }
                />
              );
            })}
          </section>
        ))
      )}

      {data.selfManaged.map((app) => (
        <SelfManagedUpdates key={app.appId} title={app.displayName} services={app.services} />
      ))}

      {data.ignored.length > 0 && <IgnoredList entries={data.ignored} onRestore={unignore} />}

      {data.unknownCount > 0 && data.apps.length > 0 && (
        <p className="type-body-sm text-muted-foreground">
          {data.unknownCount} image{data.unknownCount === 1 ? "" : "s"} could not be checked and are
          not listed.
        </p>
      )}

      <MigrationDialog
        prompt={migration}
        orgId={orgId}
        onClose={() => setMigration(null)}
        onConfirm={acknowledge}
      />
    </div>
  );
}

/** Hidden updates stay listed, with the rule and a way out of it. */
function IgnoredList({
  entries,
  onRestore,
}: {
  entries: FleetIgnoredUpdate[];
  onRestore: (entry: FleetIgnoredUpdate) => void;
}) {
  return (
    <details className="squircle rounded-lg border bg-card">
      <summary className="type-body-sm flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <BellOff className="size-3.5" aria-hidden="true" />
        Ignored ({entries.length})
        <ChevronDown className="ml-auto size-4 transition-transform" aria-hidden="true" />
      </summary>
      <ul className="divide-y border-t">
        {entries.map((entry) => (
          <li
            key={`${entry.appId}:${entry.service.service ?? ""}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
          >
            <span className="type-body-sm">{entry.displayName}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {entry.service.service ?? entry.service.image}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {entry.service.currentTag} → {entry.service.latestTag ?? entry.service.majorAvailable}
            </span>
            <span className="type-label text-muted-foreground/60">
              {describeRule(entry.rule)}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => onRestore(entry)}
            >
              Stop ignoring
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** What the batch actually did, per app. Failures are named, not summed away. */
function BatchOutcome({ report }: { report: BatchReport }) {
  return (
    <section
      aria-label="Batch update result"
      className={`squircle rounded-lg border p-4 space-y-2 ${
        report.failed > 0 ? "border-status-warning/30 bg-status-warning-muted/30" : "bg-card"
      }`}
    >
      <p className="type-body-sm flex items-center gap-2">
        {report.failed > 0 ? (
          <TriangleAlert className="size-4 shrink-0 text-status-warning" aria-hidden="true" />
        ) : (
          <CircleCheck className="size-4 shrink-0 text-status-success" aria-hidden="true" />
        )}
        {report.message}
      </p>
      <ul className="space-y-1">
        {report.apps.map((app) => (
          <li key={app.appId} className="type-body-sm text-muted-foreground">
            <span className="text-foreground">{app.displayName}</span>
            {app.applied > 0 && ` — ${app.applied} pinned`}
            {app.failed.map((item) => (
              <span key={`${item.service ?? ""}-${item.tag}`} className="block pl-4 text-status-warning">
                {item.service ?? "image"} → {item.tag}: {item.error}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
