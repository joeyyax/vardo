"use client";

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { detectProjectIcon } from "@/lib/ui/project-icon";

type Tag = { id: string; name: string; color: string };
type Group = { id: string; name: string; color: string };

type ProjectWithRelations = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  source: string;
  deployType: string;
  imageName: string | null;
  gitUrl: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  domains: { domain: string; isPrimary: boolean | null }[];
  deployments: { id: string; status: string; startedAt: Date; finishedAt: Date | null }[];
  projectTags: { tag: Tag }[];
  projectGroups: { group: Group }[];
};

type ProjectGridProps = {
  projects: ProjectWithRelations[];
  allTags: Tag[];
  allGroups: Group[];
  orgId: string;
};

function formatUptime(date: Date): string {
  const ms = Date.now() - new Date(date).getTime();
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000) % 24;
  const d = Math.floor(ms / 86400000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function Uptime({ since }: { since: Date }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(formatUptime(since));
    const interval = setInterval(() => setText(formatUptime(since)), 1000);
    return () => clearInterval(interval);
  }, [since]);
  if (!text) return null;
  return <span className="tabular-nums">{text}</span>;
}

export function ProjectGrid({ projects, allTags }: ProjectGridProps) {
  const router = useRouter();
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const interval = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(interval);
  }, [router]);

  const filtered = useMemo(() => {
    if (activeTagIds.size === 0) return projects;
    return projects.filter((p) => {
      const ids = new Set(p.projectTags.map((pt) => pt.tag.id));
      for (const tagId of activeTagIds) if (!ids.has(tagId)) return false;
      return true;
    });
  }, [projects, activeTagIds]);

  return (
    <div className="space-y-4">
      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {allTags.map((tag) => {
            const on = activeTagIds.has(tag.id);
            return (
              <button key={tag.id} onClick={() => setActiveTagIds((prev) => {
                const n = new Set(prev); if (n.has(tag.id)) n.delete(tag.id); else n.add(tag.id); return n;
              })}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${on ? "text-white" : "border bg-background text-foreground hover:bg-accent"}`}
                style={on ? { backgroundColor: tag.color } : { borderColor: `${tag.color}40` }}
              >
                <span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />
                {tag.name}
              </button>
            );
          })}
          {activeTagIds.size > 0 && (
            <button onClick={() => setActiveTagIds(new Set())} className="text-xs text-muted-foreground hover:text-foreground">Clear</button>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((project) => {
          const isRunning = project.status === "active";
          const lastDeploy = project.deployments[0];
          const primaryDomain = project.domains.find((d) => d.isPrimary) || project.domains[0];
          const icon = detectProjectIcon({ imageName: project.imageName, gitUrl: project.gitUrl, deployType: project.deployType });

          return (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="squircle flex gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/50"
            >
              {icon ? (
                <img src={icon} alt="" className="size-10 shrink-0 opacity-60" />
              ) : (
                <div className="size-10 shrink-0 rounded-md bg-muted/50" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium truncate">{project.displayName}</h3>
                  {isRunning ? (
                    <span className="flex items-center gap-1.5 text-xs text-status-success shrink-0">
                      <span className="size-1.5 rounded-full bg-status-success animate-pulse" />
                      {lastDeploy?.finishedAt ? <Uptime since={lastDeploy.finishedAt} /> : "Running"}
                    </span>
                  ) : project.status === "error" ? (
                    <span className="text-xs text-status-error shrink-0">Error</span>
                  ) : project.status === "deploying" ? (
                    <span className="text-xs text-status-info animate-pulse shrink-0">Deploying</span>
                  ) : (
                    <span className="text-xs text-status-neutral shrink-0">Stopped</span>
                  )}
                </div>
                {primaryDomain && (
                  <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">{primaryDomain.domain}</p>
                )}
                <p className="text-xs text-muted-foreground/50 mt-1 truncate">
                  {project.imageName || project.gitUrl?.replace("https://github.com/", "").replace(".git", "") || project.deployType}
                </p>
                {project.projectTags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {project.projectTags.map(({ tag }) => (
                      <span key={tag.id} className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                        style={{ backgroundColor: `${tag.color}15`, color: tag.color }}>
                        <span className="size-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
                        {tag.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </Link>
          );
        })}
      </div>

      {filtered.length === 0 && projects.length > 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <p className="text-sm text-muted-foreground">No projects match the current filters.</p>
          <button onClick={() => setActiveTagIds(new Set())} className="text-sm text-primary hover:underline">Clear filters</button>
        </div>
      )}
    </div>
  );
}
