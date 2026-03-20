"use client";

import { useMemo, useState } from "react";
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
  deployType: string;
  status: string;
  createdAt: Date;
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
        <Badge className="border-transparent bg-green-500/15 text-green-700 dark:text-green-400">
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
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const [activeGroupId, setActiveGroupId] = useState<string>("all");

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
        {filteredProjects.map((project) => (
          <Link
            key={project.id}
            href={`/projects/${project.id}`}
            className="squircle flex flex-col gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 cursor-pointer"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate font-medium">
                  {project.displayName}
                </h3>
                <p className="truncate text-xs text-muted-foreground">
                  {project.name}
                </p>
              </div>
              <StatusBadge status={project.status} />
            </div>

            {project.description && (
              <p className="line-clamp-2 text-sm text-muted-foreground">
                {project.description}
              </p>
            )}

            <div className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded bg-muted px-1.5 py-0.5">
                {deployTypeLabel(project.deployType)}
              </span>
              <span>
                {new Date(project.createdAt).toLocaleDateString()}
              </span>
            </div>

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
        ))}
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
