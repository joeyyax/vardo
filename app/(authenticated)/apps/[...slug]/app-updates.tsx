"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/lib/messenger";
import { pendingImageChange } from "@/lib/docker/image-updates/pending";

type Severity = "patch" | "minor" | "major" | "build" | "unknown";

type ServiceUpdate = {
  service: string | null;
  image: string;
  currentTag: string;
  status: "current" | "update" | "drift" | "unknown";
  latestTag: string | null;
  severity: Severity | null;
  unorderable: string[];
  available: string[];
  majorAvailable: string | null;
  majorLocked: boolean;
  error: string | null;
  checkedAt: string | null;
  stale: boolean;
};

type MigrationPlan = {
  engine: string;
  strategy: string;
  hops: number[];
  needsIntermediateSteps: boolean;
  steps: string[];
  docs: string;
};

type MigrationPrompt = {
  entry: ServiceUpdate;
  tag: string;
  plan: MigrationPlan | null;
};

/** Leading integer of a tag: `16.2-alpine` → 16. */
function majorOf(tag: string): number | null {
  const match = tag.match(/^v?(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/** Whether the row's chosen target crosses a major on a version-locked image. */
function needsMigrationFor(entry: ServiceUpdate, target: string | null): boolean {
  return Boolean(entry.majorLocked && target && isMajorJump(entry.currentTag, target));
}

function isMajorJump(from: string, to: string): boolean {
  const a = majorOf(from);
  const b = majorOf(to);
  return a !== null && b !== null && b > a;
}

type AppUpdates = {
  services: ServiceUpdate[];
  updateCount: number;
  highestSeverity: Severity | null;
  hasUnknown: boolean;
};

/**
 * One in-flight request per app, shared by the header stat and the panel.
 * The endpoint reads a cache, but two mounts should not mean two round trips.
 */
const inflight = new Map<string, Promise<AppUpdates>>();

function load(orgId: string, appId: string): Promise<AppUpdates> {
  const key = `${orgId}:${appId}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const request = fetch(`/api/v1/organizations/${orgId}/apps/${appId}/image-updates`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Check failed"))))
    .finally(() => setTimeout(() => inflight.delete(key), 2000));

  inflight.set(key, request);
  return request;
}

export function useImageUpdates(orgId: string, appId: string) {
  const [data, setData] = useState<AppUpdates | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    let cancelled = false;
    load(orgId, appId)
      .then((result) => !cancelled && setData(result))
      .catch(() => !cancelled && setData(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [orgId, appId]);

  useEffect(() => refresh(), [refresh]);

  return { data, loading, refresh };
}

/** Only a major bump earns color. A patch is routine and should read as routine. */
function severityClass(severity: Severity | null): string {
  return severity === "major" ? "text-status-warning" : "text-foreground";
}

function severityLabel(entry: ServiceUpdate): string {
  if (entry.status === "drift") return "rebuilt upstream";
  return entry.severity && entry.severity !== "unknown" ? entry.severity : "";
}

/** Compact value for the header stat strip. */
export function AppUpdateStat({ orgId, appId }: { orgId: string; appId: string }) {
  const { data, loading } = useImageUpdates(orgId, appId);

  if (loading) return <span className="text-muted-foreground/50">—</span>;
  if (!data || data.services.length === 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }

  if (data.updateCount === 0) {
    return (
      <span className={data.hasUnknown ? "text-muted-foreground" : ""}>
        {data.hasUnknown ? "Not verified" : "Up to date"}
      </span>
    );
  }

  return (
    <span className={severityClass(data.highestSeverity)}>
      {data.updateCount} available
    </span>
  );
}

/**
 * Inline update list. Renders nothing when every image is current, so a
 * healthy app carries no chrome for this.
 */
export function AppUpdatesPanel({
  orgId,
  appId,
  onDeploy,
  deploying,
  deployed,
}: {
  orgId: string;
  appId: string;
  onDeploy: () => void;
  deploying: boolean;
  /** Image each service last deployed, keyed by compose service ("" when single-image). */
  deployed?: Record<string, string | null>;
}) {
  const { data, loading, refresh } = useImageUpdates(orgId, appId);
  const [applying, setApplying] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /** service → tag the user picked, when it differs from the default. */
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [migration, setMigration] = useState<MigrationPrompt | null>(null);

  const actionable = (data?.services ?? []).filter(
    (entry) => entry.status === "update" || entry.status === "drift",
  );
  const unverified = (data?.services ?? []).filter((entry) => entry.status === "unknown");
  const undeployed = (data?.services ?? []).filter((entry) =>
    pendingImageChange(deployed?.[entry.service ?? ""], entry.image),
  );

  if (loading || !data) return null;

  // Its own tab, so it answers rather than disappears when there is no work.
  if (actionable.length === 0 && unverified.length === 0) {
    return (
      <section
        aria-label="Image updates"
        className="squircle rounded-lg border bg-card px-4 py-6 text-center"
      >
        <p className="type-body text-muted-foreground">Every image in compose is up to date.</p>
        {undeployed.length > 0 && (
          <div className="mt-3">
            <UndeployedNote count={undeployed.length} onDeploy={onDeploy} deploying={deploying} />
          </div>
        )}
        <button
          type="button"
          onClick={refresh}
          className="type-body-sm mt-1 text-muted-foreground/70 underline underline-offset-2 transition-opacity hover:opacity-80"
        >
          Check again
        </button>
      </section>
    );
  }

  /** What the row will apply: the user's pick, else the safe default. */
  function targetTag(entry: ServiceUpdate): string | null {
    return chosen[entry.service ?? ""] ?? entry.latestTag ?? entry.majorAvailable ?? null;
  }

  async function apply(entry: ServiceUpdate, acknowledgeMigration = false) {
    const key = entry.service ?? "";
    const tag = targetTag(entry);
    if (!tag) {
      // A drifted floating tag has no new tag — deploying re-pulls it.
      onDeploy();
      return;
    }
    if (entry.severity === "major" && !acknowledgeMigration && confirming !== key) {
      setConfirming(key);
      return;
    }

    setApplying(key);
    setConfirming(null);
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
      if (res.status === 409 && body.requiresMigration) {
        setMigration({ entry, tag, plan: body.plan ?? null });
        return;
      }
      if (!res.ok) throw new Error(body.error ?? "Update failed");

      toast.success(`Pinned ${entry.service ?? "image"} to ${tag}`);
      refresh();
      onDeploy();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Update failed");
    } finally {
      setApplying(null);
    }
  }

  return (
    <section
      aria-label="Image updates"
      className="squircle rounded-lg border bg-card divide-y"
    >
      <header className="flex items-center gap-2 px-4 py-2.5">
        <h2 className="type-label text-muted-foreground/60">Image updates</h2>
        <button
          type="button"
          onClick={refresh}
          className="ml-auto text-muted-foreground/50 hover:text-foreground transition-colors"
          aria-label="Re-read update status"
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </button>
      </header>

      {/* Names the fact in each column: these tags come from compose, not from
          the running containers. */}
      <div
        aria-hidden="true"
        className="hidden px-4 py-1.5 type-label text-muted-foreground/50 sm:grid sm:grid-cols-[minmax(6rem,10rem)_auto_1rem_13rem_minmax(0,1fr)_auto] sm:items-center sm:gap-x-3"
      >
        <span>Service</span>
        <span>In compose</span>
        <span />
        <span>Update to</span>
        <span />
        <span />
      </div>

      {actionable.map((entry) => {
        const key = entry.service ?? "";
        const label = severityLabel(entry);
        return (
          <div
            key={key}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(6rem,10rem)_auto_1rem_13rem_minmax(0,1fr)_auto]"
          >
            <span className="truncate font-mono text-xs text-muted-foreground">
              {entry.service}
              {/* The column that carries this is hidden on narrow screens. */}
              <span className="sm:hidden"> · {entry.currentTag}</span>
            </span>
            <span className="hidden whitespace-nowrap font-mono text-sm text-muted-foreground sm:inline">
              {entry.currentTag}
            </span>
            <ArrowRight
              className="hidden size-3 text-muted-foreground/40 sm:inline"
              aria-hidden="true"
            />
            {entry.available.length > 1 ? (
              <Select
                value={targetTag(entry) ?? undefined}
                onValueChange={(tag) => setChosen((prev) => ({ ...prev, [key]: tag }))}
              >
                <SelectTrigger
                  className="col-span-2 h-7 w-full font-mono sm:col-span-1"
                  aria-label={`Version for ${entry.service ?? entry.image}`}
                >
                  {/* Children, not the selected item's own markup — otherwise the
                      dropdown's migration marker is echoed inside the trigger. */}
                  <SelectValue>{targetTag(entry)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {entry.available.map((tag) => {
                    const crossesMajor = entry.majorLocked && isMajorJump(entry.currentTag, tag);
                    return (
                      <SelectItem key={tag} value={tag} className="font-mono">
                        {tag}
                        {crossesMajor && (
                          <span className="ml-2 type-label text-status-warning">
                            needs migration
                          </span>
                        )}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            ) : (
              <span className={`whitespace-nowrap font-mono text-sm ${severityClass(entry.severity)}`}>
                {targetTag(entry) ?? "rebuilt"}
              </span>
            )}
            {/* Never hidden by breakpoint — this is the warning that stops a
                datastore being pinned across a major it cannot start on. */}
            <span className="type-label truncate text-muted-foreground/50">
              {needsMigrationFor(entry, targetTag(entry)) ? (
                <span className="text-status-warning">Needs migration</span>
              ) : (
                <span className="hidden sm:inline">{label}</span>
              )}
            </span>
            <Button
              size="sm"
              variant={confirming === key ? "default" : "outline"}
              disabled={applying === key || deploying}
              onClick={() => apply(entry)}
            >
              {confirming === key
                ? `Confirm ${targetTag(entry)}`
                : applying === key
                  ? "Applying…"
                  : "Update"}
            </Button>
          </div>
        );
      })}

      {unverified.length > 0 && (
        <p className="px-4 py-2.5 text-xs text-muted-foreground">
          {unverified.length} image{unverified.length === 1 ? "" : "s"} could not be checked
          {unverified[0].error ? ` — ${unverified[0].error}` : ""}.
        </p>
      )}

      {undeployed.length > 0 && (
        <div className="px-4 py-2.5">
          <UndeployedNote count={undeployed.length} onDeploy={onDeploy} deploying={deploying} />
        </div>
      )}

      <MigrationDialog
        prompt={migration}
        orgId={orgId}
        appId={appId}
        onClose={() => setMigration(null)}
        onConfirm={(entry) => {
          setMigration(null);
          apply(entry, true);
        }}
      />
    </section>
  );
}

/** Compose pins that no deploy has applied yet. */
function UndeployedNote({
  count,
  onDeploy,
  deploying,
}: {
  count: number;
  onDeploy: () => void;
  deploying: boolean;
}) {
  return (
    <div className="squircle flex flex-wrap items-center justify-center gap-2 rounded-md border border-status-warning/30 bg-status-warning-muted p-2.5 type-body-sm text-muted-foreground">
      <TriangleAlert className="size-3.5 shrink-0 text-status-warning" aria-hidden="true" />
      <span>
        {count} image{count === 1 ? " is" : "s are"} pinned in compose but not deployed.
      </span>
      <Button size="sm" variant="outline" disabled={deploying} onClick={onDeploy}>
        Deploy
      </Button>
    </div>
  );
}

/**
 * Runs the backup the migration steps ask for, rather than only naming it.
 * Git-sourced apps still need this — the code is in git, the data is not.
 */
function BackupBeforeMigration({ orgId, appId }: { orgId: string; appId: string }) {
  const [state, setState] = useState<"idle" | "running" | "started" | "unavailable">("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [gitSourced, setGitSourced] = useState(false);

  async function backup() {
    setState("running");
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/backup-now`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await res.json();
      if (!res.ok) {
        // NO_VOLUMES and BIND_MOUNTS_ONLY are answers, not failures.
        setState("unavailable");
        setDetail(body.error ?? "Could not start a backup");
        return;
      }
      setGitSourced(Boolean(body.assessment?.gitSourced));
      setDetail((body.warnings ?? []).join(" ") || null);
      setState("started");
    } catch {
      setState("unavailable");
      setDetail("Could not reach the backup service");
    }
  }

  if (state === "started") {
    return (
      <p className="type-body-sm rounded-md border border-status-success/30 bg-status-success-muted/30 p-2.5 text-muted-foreground">
        <span className="text-status-success">Backup started.</span> Track it on the Backups tab
        before continuing.
        {gitSourced && " Code is in git; this captures the data volumes."}
        {detail ? ` ${detail}` : ""}
      </p>
    );
  }

  if (state === "unavailable") {
    return (
      <p className="type-body-sm rounded-md border border-status-warning/30 bg-status-warning-muted/30 p-2.5 text-status-warning">
        {detail} — back up by hand before continuing.
      </p>
    );
  }

  return (
    <Button variant="outline" className="w-full" disabled={state === "running"} onClick={backup}>
      {state === "running" ? "Starting backup…" : "Back up now"}
    </Button>
  );
}

/**
 * Shown when a pick crosses a major on an image whose data directory is tied to
 * that major. The deploy would fail on the version check, so the recipe comes
 * before the confirm rather than after the outage.
 */
function MigrationDialog({
  prompt,
  orgId,
  appId,
  onClose,
  onConfirm,
}: {
  prompt: MigrationPrompt | null;
  orgId: string;
  appId: string;
  onClose: () => void;
  onConfirm: (entry: ServiceUpdate) => void;
}) {
  if (!prompt) return null;
  const { entry, tag, plan } = prompt;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-4 text-status-warning" aria-hidden="true" />
            {entry.currentTag} → {tag} is a data migration
          </DialogTitle>
          <DialogDescription>
            {plan?.engine ?? entry.image} stores data in a format tied to its major version. Pinning
            this tag alone will not start — the new container refuses the existing data directory.
          </DialogDescription>
        </DialogHeader>

        {plan?.needsIntermediateSteps && (
          <p className="text-sm text-status-warning">
            {plan.engine} cannot jump straight there. Land on {plan.hops.join(", then ")} in order.
          </p>
        )}

        {plan && (
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            {plan.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}

        <BackupBeforeMigration orgId={orgId} appId={appId} />

        <DialogFooter className="sm:justify-between">
          {plan && (
            <a
              href={plan.docs}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted-foreground underline self-center"
            >
              Upstream upgrade notes
            </a>
          )}
          <span className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => onConfirm(entry)}>
              Pin {tag} anyway
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
