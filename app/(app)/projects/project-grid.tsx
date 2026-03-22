"use client";

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Tag = {
  id: string;
  name: string;
  color: string;
};

type Group = {
  id: string;
  name: string;
  color: string;
};

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
};

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return (
        <Badge className="border-transparent bg-status-success-muted text-status-success">
          Active
        </Badge>
      );
    case "deploying":
      return (
        <Badge variant="outline" className="animate-pulse">
          Deploying
        </Badge>
      );
    case "error":
      return <Badge variant="destructive">Error</Badge>;
    default:
      return <Badge variant="secondary">Stopped</Badge>;
  }
}

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

function deployTypeLabel(deployType: string) {
  switch (deployType) {
    case "compose":
      return "Compose";
    case "dockerfile":
      return "Dockerfile";
    case "image":
      return "Image";
    case "static":
      return "Static";
    default:
      return deployType;
  }
}

export function ProjectGrid({ projects, allTags, allGroups }: ProjectGridProps) {
  const router = useRouter();
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const [activeGroupId, setActiveGroupId] = useState<string>("all");

  // Poll for updates every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(interval);
  }, [router]);

  const filteredProjects = useMemo(() => {
    return projects.filter((project) => {
      // Filter by tags (AND logic: project must have all selected tags)
      if (activeTagIds.size > 0) {
        const projectTagIds = new Set(project.projectTags.map((pt) => pt.tag.id));
        for (const tagId of activeTagIds) {
          if (!projectTagIds.has(tagId)) return false;
        }
      }

      // Filter by group
      if (activeGroupId !== "all") {
        const inGroup = project.projectGroups.some(
          (pg) => pg.group.id === activeGroupId
        );
        if (!inGroup) return false;
      }

      return true;
    });
  }, [projects, activeTagIds, activeGroupId]);

  function toggleTag(tagId: string) {
    setActiveTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }
      return next;
    });
  }

  const showFilters = allTags.length > 0 || allGroups.length > 0;

  return (
    <div className="space-y-4">
      {showFilters && (
        <div className="flex flex-wrap items-center gap-3">
          {allTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {allTags.map((tag) => {
                const isActive = activeTagIds.has(tag.id);
                return (
                  <button
                    key={tag.id}
                    onClick={() => toggleTag(tag.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                      isActive
                        ? "text-white"
                        : "border bg-background text-foreground hover:bg-accent"
                    }`}
                    style={
                      isActive
                        ? { backgroundColor: tag.color }
                        : { borderColor: `${tag.color}40` }
                    }
                  >
                    <span
                      className="size-2 rounded-full shrink-0"
                      style={{ backgroundColor: tag.color }}
                      aria-hidden="true"
                    />
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}

          {allGroups.length > 0 && (
            <Select value={activeGroupId} onValueChange={setActiveGroupId}>
              <SelectTrigger className="w-[160px] h-8 text-xs">
                <SelectValue placeholder="All groups" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All groups</SelectItem>
                {allGroups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    <span className="flex items-center gap-2">
                      <span
                        className="size-2 rounded-full shrink-0"
                        style={{ backgroundColor: group.color }}
                        aria-hidden="true"
                      />
                      {group.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {(activeTagIds.size > 0 || activeGroupId !== "all") && (
            <button
              onClick={() => {
                setActiveTagIds(new Set());
                setActiveGroupId("all");
              }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filteredProjects.map((project) => {
          const primaryDomain = project.domains.find((d) => d.isPrimary) || project.domains[0];
          const lastDeploy = project.deployments[0];
          const isRunning = project.status === "active";
          const source = project.gitUrl
            ? project.gitUrl.replace("https://github.com/", "").replace(".git", "")
            : project.imageName || deployTypeLabel(project.deployType);

          return (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="squircle flex flex-col gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 cursor-pointer"
            >
              {/* Header: name + status */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate font-medium">
                    {project.displayName}
                  </h3>
                  {primaryDomain && (
                    <p className="truncate text-xs text-muted-foreground font-mono">
                      {primaryDomain.domain}
                    </p>
                  )}
                </div>
                {isRunning ? (
                  <span className="flex items-center gap-1.5 text-xs text-status-success shrink-0">
                    <span className="size-1.5 rounded-full bg-status-success animate-pulse" />
                    {lastDeploy?.finishedAt ? (
                      <Uptime since={lastDeploy.finishedAt} />
                    ) : (
                      "Running"
                    )}
                  </span>
                ) : project.status === "error" ? (
                  <span className="text-xs text-status-error shrink-0">Error</span>
                ) : project.status === "deploying" ? (
                  <span className="text-xs text-status-info animate-pulse shrink-0">Deploying</span>
                ) : (
                  <span className="text-xs text-status-neutral shrink-0">Stopped</span>
                )}
              </div>

              {/* Source */}
              <p className="truncate text-xs text-muted-foreground">
                {source}
              </p>

              {/* Footer: deploy type + last deploy */}
              <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5">
                  {deployTypeLabel(project.deployType)}
                </span>
                {lastDeploy ? (
                  <span>
                    {lastDeploy.status === "success" ? "Deployed" : lastDeploy.status === "failed" ? "Failed" : "Deploying"}{" "}
                    {new Date(lastDeploy.startedAt).toLocaleDateString()}
                  </span>
                ) : (
                  <span>Never deployed</span>
                )}
              </div>

              {/* Tags */}
              {project.projectTags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {project.projectTags.map(({ tag }) => (
                    <span
                      key={tag.id}
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{
                        backgroundColor: `${tag.color}20`,
                        color: tag.color,
                      }}
                    >
                      <span
                        className="size-1.5 rounded-full"
                        style={{ backgroundColor: tag.color }}
                        aria-hidden="true"
                      />
                      {tag.name}
                    </span>
                  ))}
                </div>
              )}
            </Link>
          );
        })}
      </div>

      {filteredProjects.length === 0 && projects.length > 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <p className="text-sm text-muted-foreground">
            No projects match the current filters.
          </p>
          <button
            onClick={() => {
              setActiveTagIds(new Set());
              setActiveGroupId("all");
            }}
            className="text-sm text-primary hover:underline"
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
