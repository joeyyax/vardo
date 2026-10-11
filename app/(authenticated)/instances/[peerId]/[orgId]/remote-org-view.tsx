"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Loader2, ServerOff } from "lucide-react";
import { PageToolbar } from "@/components/page-toolbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import { InstanceBadge } from "@/components/instances/instance-badge";
import { openOnInstance } from "@/lib/instances/client";
import { formatRelativeTime } from "@/lib/ui/relative-time";
import type { DirectoryInstance, DirectoryResult, RemoteApp, RemoteProject } from "@/lib/instances/directory";

type ProjectsResponse = DirectoryResult<RemoteProject[]> & { instance?: DirectoryInstance | null };

async function loadProjects(peerId: string, orgId: string): Promise<ProjectsResponse> {
  try {
    const res = await fetch(
      `/api/v1/instances/${encodeURIComponent(peerId)}/organizations/${encodeURIComponent(orgId)}/projects`,
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      return { state: "refused", reason: json.error || "Couldn't load this instance's projects" };
    }
    return await res.json();
  } catch {
    return { state: "unreachable" };
  }
}

function appTone(app: RemoteApp) {
  if (app.attention) return app.status === "error" ? "issue" : "warn";
  if (app.status === "active") return "good";
  if (app.status === "deploying") return "info";
  if (app.status === "stopped") return "stopped";
  return "neutral";
}

/** A linked instance's projects for one of the user's orgs there. Read-only; every action opens the owning instance. */
export function RemoteOrgView({ peerId, orgId }: { peerId: string; orgId: string }) {
  const [data, setData] = useState<ProjectsResponse | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadProjects(peerId, orgId).then((res) => live && setData(res));
    return () => {
      live = false;
    };
  }, [peerId, orgId]);

  const name = data?.instance?.name ?? "Linked instance";
  const canOpen = !!data?.instance?.signIn;

  async function open(key: string, next: string) {
    setOpening(key);
    if (!(await openOnInstance(peerId, { next, organizationId: orgId }))) setOpening(null);
  }

  function openButton(id: string, next: string, label: string) {
    if (!canOpen) return null;
    return (
      <Button variant="outline" size="xs" disabled={opening !== null} onClick={() => open(id, next)} aria-label={label}>
        {opening === id ? <Loader2 className="animate-spin" /> : <ExternalLink />}
        Open on {name}
      </Button>
    );
  }

  return (
    <div className="space-y-8">
      <PageToolbar actions={openButton("org", "/projects", `Open projects on ${name}`)}>
        <h1 className="type-h1">Projects</h1>
        <InstanceBadge name={name} />
      </PageToolbar>

      {!data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading from {name}
        </div>
      ) : data.state === "unreachable" ? (
        <EmptyState icon={ServerOff} title={`${name} is unreachable`} body="Its projects show here again once it answers." />
      ) : data.state === "refused" ? (
        <EmptyState icon={ServerOff} title={`Can't browse ${name}`} body={data.reason} />
      ) : data.data.length === 0 ? (
        <EmptyState title={`No projects on ${name}`} body="Projects created there show here." />
      ) : (
        <div className="space-y-4">
          {data.data.map((project) => (
            <Card key={project.id}>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <h2 className="type-h4 truncate">{project.displayName}</h2>
                    <InstanceBadge name={name} />
                  </div>
                  {openButton(project.id, `/projects/${encodeURIComponent(project.name)}`, `Open ${project.displayName} on ${name}`)}
                </div>
                {project.apps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No apps</p>
                ) : (
                  <ul className="divide-y">
                    {project.apps.map((app) => (
                      <li key={app.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-medium">{app.displayName}</span>
                            <InstanceBadge name={name} />
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {[
                              app.domains.join(", "),
                              app.lastDeployedAt && `Deployed ${formatRelativeTime(app.lastDeployedAt)}`,
                            ]
                              .filter(Boolean)
                              .join(" · ") || "No domains"}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <StatusDot tone={appTone(app)} title={app.attention ?? undefined}>
                            {app.attention ?? app.status}
                          </StatusDot>
                          {openButton(app.id, `/apps/${encodeURIComponent(app.name)}`, `Open ${app.displayName} on ${name}`)}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
