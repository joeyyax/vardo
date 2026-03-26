"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { ContainerCard } from "./container-card";
import { ComposeGroupCard } from "./compose-group-card";
import { ImportDialog } from "./import-dialog";
import type { DiscoveryResponse, DiscoveredContainer } from "@/lib/docker/discover";

type Project = { id: string; name: string; displayName: string };

type DiscoverViewProps = {
  orgId: string;
  projects: Project[];
};

export function DiscoverView({ orgId, projects }: DiscoverViewProps) {
  const [data, setData] = useState<DiscoveryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [importTarget, setImportTarget] = useState<DiscoveredContainer | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/discover/containers`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load containers");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  function handleImport(container: DiscoveredContainer) {
    setImportTarget(container);
    setImportOpen(true);
  }

  const totalCount = data
    ? data.standalone.length + data.groups.reduce((n, g) => n + g.containers.length, 0)
    : 0;

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {loading
            ? "Scanning containers..."
            : error
            ? "Failed to load containers"
            : totalCount === 0
            ? "No unmanaged containers found"
            : `${totalCount} unmanaged container${totalCount !== 1 ? "s" : ""} found`}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={load}
          disabled={loading}
        >
          <RefreshCw className={`size-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {!loading && !error && data && (
        <div className="space-y-6">
          {data.standalone.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Standalone
              </h2>
              <div className="space-y-2">
                {data.standalone.map((c) => (
                  <ContainerCard
                    key={c.id}
                    container={c}
                    orgId={orgId}
                    onImport={handleImport}
                  />
                ))}
              </div>
            </section>
          )}

          {data.groups.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Compose stacks
              </h2>
              <div className="space-y-3">
                {data.groups.map((g) => (
                  <ComposeGroupCard
                    key={g.composeProject}
                    composeProject={g.composeProject}
                    containers={g.containers}
                    orgId={orgId}
                    onImport={handleImport}
                  />
                ))}
              </div>
            </section>
          )}

          {totalCount === 0 && (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                All running containers are already managed by Vardo.
              </p>
            </div>
          )}
        </div>
      )}

      <ImportDialog
        container={importTarget}
        orgId={orgId}
        projects={projects}
        open={importOpen}
        onOpenChange={setImportOpen}
      />
    </>
  );
}
