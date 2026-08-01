"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/messenger";

type Severity = "patch" | "minor" | "major" | "build" | "unknown";

type ServiceUpdate = {
  service: string | null;
  image: string;
  currentTag: string;
  status: "current" | "update" | "drift" | "unknown";
  latestTag: string | null;
  severity: Severity | null;
  unorderable: string[];
  error: string | null;
  checkedAt: string | null;
  stale: boolean;
};

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
}: {
  orgId: string;
  appId: string;
  onDeploy: () => void;
  deploying: boolean;
}) {
  const { data, loading, refresh } = useImageUpdates(orgId, appId);
  const [applying, setApplying] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const actionable = (data?.services ?? []).filter(
    (entry) => entry.status === "update" || entry.status === "drift",
  );
  const unverified = (data?.services ?? []).filter((entry) => entry.status === "unknown");

  if (loading || !data || (actionable.length === 0 && unverified.length === 0)) return null;

  async function apply(entry: ServiceUpdate) {
    const key = entry.service ?? "";
    if (!entry.latestTag) {
      // A drifted floating tag has no new tag — deploying re-pulls it.
      onDeploy();
      return;
    }
    if (entry.severity === "major" && confirming !== key) {
      setConfirming(key);
      return;
    }

    setApplying(key);
    setConfirming(null);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/image-updates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service: entry.service, tag: entry.latestTag }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Update failed");

      toast.success(`Pinned ${entry.service ?? "image"} to ${entry.latestTag}`);
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

      {actionable.map((entry) => {
        const key = entry.service ?? "";
        const label = severityLabel(entry);
        return (
          <div key={key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
            {entry.service && (
              <span className="font-mono text-xs text-muted-foreground">{entry.service}</span>
            )}
            <span className="flex items-center gap-2 text-sm">
              <span className="font-mono text-muted-foreground">{entry.currentTag}</span>
              <ArrowRight className="size-3 text-muted-foreground/40" aria-hidden="true" />
              <span className={`font-mono ${severityClass(entry.severity)}`}>
                {entry.latestTag ?? "rebuilt"}
              </span>
            </span>
            {label && (
              <span className="type-label text-muted-foreground/50">{label}</span>
            )}
            <Button
              size="sm"
              variant={confirming === key ? "default" : "outline"}
              className="ml-auto"
              disabled={applying === key || deploying}
              onClick={() => apply(entry)}
            >
              {confirming === key
                ? `Confirm ${entry.latestTag}`
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
    </section>
  );
}
