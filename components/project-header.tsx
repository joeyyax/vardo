"use client";

import { Layers } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import { HeaderStat, RollupStatus } from "@/components/entity-header";
import { priorityMeta } from "@/lib/ui/app-priority";
import { rollupHealth, type RollupMember } from "@/lib/ui/health-rollup";

export type ProjectHeaderApp = RollupMember & {
  deployments?: { status: string; startedAt: Date; finishedAt: Date | null }[];
};

export type ProjectHeaderProject = {
  displayName: string;
  description: string | null;
  color: string | null;
  createdAt: Date;
};

/**
 * Heading block for the project detail page — the same roll-up and geometry the
 * app header gives a compose stack.
 *
 * Pass every app on the project; rows nested under a compose parent are dropped
 * by the roll-up rather than counted twice.
 */
export function ProjectHeader({
  project,
  apps,
}: {
  project: ProjectHeaderProject;
  apps: ProjectHeaderApp[];
}) {
  const rollup = rollupHealth(apps);
  const critical = priorityMeta("critical");
  const CriticalIcon = critical?.icon;

  const lastDeploy = apps
    .flatMap((a) => a.deployments ?? [])
    .filter((d) => d.status === "success")
    .map((d) => d.finishedAt || d.startedAt)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

  return (
    <div className="flex gap-5">
      <div
        className="size-12 shrink-0 rounded-lg flex items-center justify-center mt-0.5"
        style={{ backgroundColor: project.color ? `${project.color}20` : undefined }}
      >
        <Layers
          className="size-6"
          style={{ color: project.color ?? undefined }}
          aria-hidden="true"
        />
      </div>

      <div className="flex-1 min-w-0 space-y-3">
        {project.description && (
          <p className="text-sm text-muted-foreground">{project.description}</p>
        )}

        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          {rollup.critical > 0 && critical && CriticalIcon && (
            <span className={`flex items-center gap-1 ${critical.tone}`} title={critical.title}>
              <CriticalIcon className="size-3" aria-hidden="true" />
              {rollup.critical} critical
            </span>
          )}
          {rollup.attention > 0 && (
            <span className="text-status-warning">
              {rollup.attention} need{rollup.attention === 1 ? "s" : ""} attention
            </span>
          )}
          <span className="text-muted-foreground/40">
            Created <RelativeTime date={project.createdAt} absoluteFirst />
          </span>
        </div>

        <dl className="flex flex-wrap gap-x-10 gap-y-4">
          <HeaderStat label="Status">
            <RollupStatus rollup={rollup} noun="app" />
          </HeaderStat>
          <HeaderStat label="Apps">
            <span className="tabular-nums">{rollup.total}</span>
          </HeaderStat>
          {lastDeploy && (
            <HeaderStat label="Last deploy">
              <RelativeTime date={lastDeploy} absoluteFirst />
            </HeaderStat>
          )}
        </dl>
      </div>
    </div>
  );
}
