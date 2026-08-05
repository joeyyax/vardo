"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MajorGateDialog,
  MigrationDialog,
  type MigrationPrompt,
} from "@/components/image-updates/migration-dialog";
import {
  UpdateRow,
  UpdateRowHeader,
  defaultTarget,
  severityClass,
  type ServiceUpdate,
} from "@/components/image-updates/update-row";
import { IgnoreMenu, type IgnoreChoice } from "@/components/image-updates/ignore-menu";
import { SelfManagedUpdates } from "@/components/image-updates/self-managed-updates";
import { toast } from "@/lib/messenger";
import { requiresMigration, type MigrationPlan } from "@/lib/docker/image-updates/migration-path";
import { describeRule } from "@/lib/docker/image-updates/ignore";
import { pendingImageChange } from "@/lib/docker/image-updates/pending";
import type { MajorGateBlock } from "@/lib/docker/image-updates/major-gate";
import type {
  AppUpdateStatus,
  IgnoredUpdate,
  ServiceUpdateStatus,
} from "@/lib/docker/image-updates/status";

type AppUpdates = AppUpdateStatus;
type Severity = ServiceUpdateStatus["severity"];

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

/** Compact value for the header stat strip. */
export function AppUpdateStat({ orgId, appId }: { orgId: string; appId: string }) {
  const { data, loading } = useImageUpdates(orgId, appId);

  if (loading) return <span className="text-muted-foreground/50">—</span>;
  if (!data || data.services.length === 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }

  if (data.selfManaged) {
    return <span className="text-muted-foreground">Moves with Vardo</span>;
  }

  if (data.updateCount === 0) {
    return (
      <span className={data.hasUnknown ? "text-muted-foreground" : ""}>
        {data.hasUnknown ? "Not verified" : "Up to date"}
      </span>
    );
  }

  return (
    <span className={severityClass(data.highestSeverity as Severity)}>
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
  appName,
  onDeploy,
  deploying,
  deployed,
}: {
  orgId: string;
  appId: string;
  appName: string;
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
  const [migrationPlan, setMigrationPlan] = useState<MigrationPlan | null>(null);

  // A stopped deploy opens the dialog on arrival — it is a decision, not a
  // notice — and leaves the row behind once it is closed.
  const blocked = data?.blockedMigration ?? null;
  const blockedId = blocked?.deploymentId ?? null;
  const [gateOpen, setGateOpen] = useState(false);
  useEffect(() => setGateOpen(blockedId !== null), [blockedId]);

  const actionable = (data?.services ?? []).filter(
    (entry) => entry.status === "update" || entry.status === "drift",
  );
  const unverified = (data?.services ?? []).filter((entry) => entry.status === "unknown");
  const undeployed = (data?.services ?? []).filter((entry) =>
    pendingImageChange(deployed?.[entry.service ?? ""], entry.image),
  );

  const ignored = data?.ignored ?? [];

  async function setIgnore(entry: ServiceUpdate, choice: IgnoreChoice | null) {
    const body = JSON.stringify({ appId, service: entry.service, ...(choice ?? {}) });
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/image-updates/ignores`, {
        method: choice ? "POST" : "DELETE",
        headers: { "content-type": "application/json" },
        body,
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Could not change that ignore rule");
      toast.success(
        choice
          ? `Ignoring ${choice.scope === "major" ? "majors" : "updates"} for ${entry.service ?? "this image"}`
          : `${entry.service ?? "This image"} is back in the list`,
      );
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change that ignore rule");
    }
  }

  /** Pins one of the two majors the stopped deploy reported, then redeploys. */
  async function pinFromGate(service: string | null, tag: string, crossesMajor: boolean) {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/image-updates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          service,
          tag,
          majorGate: true,
          ...(crossesMajor ? { acknowledgeMigration: true } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not pin that tag");
      setGateOpen(false);
      toast.success(`Pinned ${service ?? "image"} to ${tag}`);
      refresh();
      onDeploy();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not pin that tag");
    }
  }

  const gateSurface = blocked ? (
    <>
      <BlockedDeployNote block={blocked} onReview={() => setGateOpen(true)} />
      <MajorGateDialog
        block={gateOpen ? blocked : null}
        orgId={orgId}
        onClose={() => setGateOpen(false)}
        onPin={pinFromGate}
      />
    </>
  ) : null;

  if (loading || !data) return null;

  if (data.selfManaged) {
    return (
      <div className="space-y-3">
        {blocked && <BlockedDeployNote block={blocked} />}
        <SelfManagedUpdates title="Image updates" services={data.services} />
      </div>
    );
  }

  // Its own tab, so it answers rather than disappears when there is no work.
  if (actionable.length === 0 && unverified.length === 0 && ignored.length === 0) {
    return (
      <section
        aria-label="Image updates"
        className="squircle rounded-lg bg-card px-4 py-6 text-center shadow-card dark:border"
      >
        {gateSurface && <div className="mb-3 text-left">{gateSurface}</div>}
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

  function targetTag(entry: ServiceUpdate): string | null {
    return defaultTarget(entry, chosen[entry.service ?? ""]);
  }

  async function apply(entry: ServiceUpdate, acknowledgeMigration = false) {
    const key = entry.service ?? "";
    const tag = targetTag(entry);
    if (!tag) {
      // A drifted floating tag has no new tag — deploying re-pulls it.
      onDeploy();
      return;
    }
    // The recipe comes before the request, not after a 409.
    if (requiresMigration(entry.image, entry.currentTag, tag) && !acknowledgeMigration) {
      setMigrationPlan(null);
      setMigration({ appId, appName, entry, tag });
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
        setMigrationPlan(body.plan ?? null);
        setMigration({ appId, appName, entry, tag });
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
    <section aria-label="Image updates" className="squircle rounded-lg bg-card divide-y shadow-card dark:border">
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

      {gateSurface && <div className="px-4 py-2.5">{gateSurface}</div>}

      <UpdateRowHeader />

      {actionable.map((entry) => {
        const key = entry.service ?? "";
        return (
          <UpdateRow
            key={key}
            entry={entry}
            target={targetTag(entry)}
            onTargetChange={(tag) => setChosen((prev) => ({ ...prev, [key]: tag }))}
            onApply={() => apply(entry)}
            applying={applying === key}
            disabled={deploying}
            confirming={confirming === key}
            ignoreSlot={
              <IgnoreMenu
                label={entry.service ?? entry.image}
                disabled={deploying}
                onChoose={(choice) => setIgnore(entry, choice)}
              />
            }
          />
        );
      })}

      {ignored.length > 0 && (
        <IgnoredRows entries={ignored} onRestore={(entry) => setIgnore(entry, null)} />
      )}

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
        plan={migrationPlan}
        orgId={orgId}
        onClose={() => setMigration(null)}
        onConfirm={(prompt) => {
          setMigration(null);
          apply(prompt.entry, true);
        }}
      />
    </section>
  );
}

/** Updates a rule is hiding on this app, listed so the rule can be undone. */
function IgnoredRows({
  entries,
  onRestore,
}: {
  entries: IgnoredUpdate[];
  onRestore: (entry: ServiceUpdate) => void;
}) {
  return (
    <div className="px-4 py-2.5 space-y-1.5">
      <p className="type-label text-muted-foreground/60">Ignored</p>
      {entries.map(({ service, rule }) => (
        <div
          key={service.service ?? service.image}
          className="flex flex-wrap items-center gap-x-3 gap-y-1"
        >
          <span className="font-mono text-xs text-muted-foreground">
            {service.service ?? service.image}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {service.currentTag} → {service.latestTag ?? service.majorAvailable}
          </span>
          <span className="type-label text-muted-foreground/50">{describeRule(rule)}</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onRestore(service)}>
            Stop ignoring
          </Button>
        </div>
      ))}
    </div>
  );
}

/** A deploy the major gate stopped, kept until the app deploys again. */
function BlockedDeployNote({
  block,
  onReview,
}: {
  block: MajorGateBlock;
  /** Omit where the pin would be refused — the note is then a statement, not an offer. */
  onReview?: () => void;
}) {
  const entry = block.services[0];
  const label = entry.service ? `${entry.service} (${entry.image})` : entry.image;

  return (
    <div className="squircle flex flex-wrap items-center gap-2 rounded-md bg-status-warning-muted p-2.5 type-body-sm text-muted-foreground">
      <TriangleAlert className="size-3.5 shrink-0 text-status-warning" aria-hidden="true" />
      <span>
        Deploy stopped — {label} moved from major {entry.from} to {entry.to}. {block.appName} is
        still serving {entry.from}.
      </span>
      {onReview && (
        <Button size="sm" variant="outline" className="ml-auto" onClick={onReview}>
          Review migration
        </Button>
      )}
    </div>
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
    <div className="squircle flex flex-wrap items-center justify-center gap-2 rounded-md bg-status-warning-muted p-2.5 type-body-sm text-muted-foreground">
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
