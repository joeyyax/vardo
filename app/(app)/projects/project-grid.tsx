"use client";

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { detectProjectIcon } from "@/lib/ui/project-icon";
import { Layers, Plus, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

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
  groupId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  domains: { domain: string; isPrimary: boolean | null }[];
  deployments: { id: string; status: string; startedAt: Date; finishedAt: Date | null }[];
  projectTags: { tag: Tag }[];
  projectGroups: { group: Group }[];
  group: Group | null;
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

function ProjectCard({ project }: { project: ProjectWithRelations }) {
  const isRunning = project.status === "active";
  const lastDeploy = project.deployments[0];
  const primaryDomain =
    project.domains.find((d) => d.isPrimary) || project.domains[0];
  const icon = detectProjectIcon({
    imageName: project.imageName,
    gitUrl: project.gitUrl,
    deployType: project.deployType,
  });

  return (
    <Link
      href={`/projects/${project.name}`}
      className="squircle flex gap-4 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50"
    >
      {icon ? (
        <img src={icon} alt="" className="size-12 shrink-0 opacity-70" />
      ) : (
        <div className="size-12 shrink-0 rounded-md bg-muted/50" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold truncate">
            {project.displayName}
          </h3>
          {isRunning ? (
            <span className="flex items-center gap-1.5 text-sm text-status-success shrink-0">
              <span className="size-2 rounded-full bg-status-success animate-pulse" />
              {lastDeploy?.finishedAt ? (
                <Uptime since={lastDeploy.finishedAt} />
              ) : (
                "Running"
              )}
            </span>
          ) : project.status === "error" ? (
            <span className="text-sm text-status-error shrink-0">Error</span>
          ) : project.status === "deploying" ? (
            <span className="text-sm text-status-info animate-pulse shrink-0">
              Deploying
            </span>
          ) : (
            <span className="text-sm text-status-neutral shrink-0">
              Stopped
            </span>
          )}
        </div>
        {primaryDomain && (
          <p className="text-sm text-muted-foreground font-mono truncate mt-1">
            {primaryDomain.domain}
          </p>
        )}
        <p className="text-sm text-muted-foreground/50 mt-1 truncate">
          {project.imageName ||
            project.gitUrl
              ?.replace("https://github.com/", "")
              .replace(".git", "") ||
            project.deployType}
        </p>
        {project.projectTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {project.projectTags.map(({ tag }) => (
              <span
                key={tag.id}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                style={{
                  backgroundColor: `${tag.color}15`,
                  color: tag.color,
                }}
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: tag.color }}
                />
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

function AddToGroupPopover({
  group,
  allProjects,
  groupProjects,
  orgId,
  onMoved,
}: {
  group: Group;
  allProjects: ProjectWithRelations[];
  groupProjects: ProjectWithRelations[];
  orgId: string;
  onMoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);

  const groupProjectIds = new Set(groupProjects.map((p) => p.id));
  const ungrouped = allProjects.filter((p) => !groupProjectIds.has(p.id));

  async function moveToGroup(projectId: string) {
    setMoving(projectId);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ groupId: group.id }),
        }
      );
      if (res.ok) {
        toast.success("Project added to group");
        setOpen(false);
        onMoved();
      } else {
        toast.error("Failed to move project");
      }
    } catch {
      toast.error("Failed to move project");
    } finally {
      setMoving(null);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs gap-1">
          <Plus className="size-3" />
          Add
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <Link
          href={`/projects/new?group=${group.id}`}
          className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors"
          onClick={() => setOpen(false)}
        >
          <Plus className="size-4 text-muted-foreground" />
          Create new project
          <ArrowRight className="size-3 ml-auto text-muted-foreground" />
        </Link>
        {ungrouped.length > 0 && (
          <>
            <div className="my-1 border-t" />
            <p className="px-3 py-1.5 text-xs text-muted-foreground">
              Move existing project into {group.name}
            </p>
            <div className="max-h-48 overflow-y-auto">
              {ungrouped.map((p) => (
                <button
                  key={p.id}
                  disabled={moving === p.id}
                  onClick={() => moveToGroup(p.id)}
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-sm w-full text-left hover:bg-accent transition-colors disabled:opacity-50"
                >
                  <span
                    className={`size-2 rounded-full shrink-0 ${
                      p.status === "active"
                        ? "bg-status-success"
                        : p.status === "error"
                        ? "bg-status-error"
                        : "bg-status-neutral"
                    }`}
                  />
                  <span className="truncate">{p.displayName}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function ProjectGrid({
  projects,
  allTags,
  allGroups,
  orgId,
}: ProjectGridProps) {
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

  // Group projects by their group for sectioned view
  const hasGroups = projects.some((p) => p.groupId);
  const isFiltering = activeTagIds.size > 0;

  const sections = useMemo(() => {
    if (!hasGroups || isFiltering) return null;

    const grouped = new Map<string, ProjectWithRelations[]>();
    const ungrouped: ProjectWithRelations[] = [];

    for (const project of filtered) {
      if (project.groupId && project.group) {
        const list = grouped.get(project.groupId) || [];
        list.push(project);
        grouped.set(project.groupId, list);
      } else {
        ungrouped.push(project);
      }
    }

    // Only show sections if there are grouped projects
    if (grouped.size === 0) return null;

    const result: { group: Group | null; projects: ProjectWithRelations[] }[] =
      [];

    for (const group of allGroups) {
      const groupProjects = grouped.get(group.id);
      if (groupProjects && groupProjects.length > 0) {
        result.push({ group, projects: groupProjects });
      }
    }

    if (ungrouped.length > 0) {
      result.push({ group: null, projects: ungrouped });
    }

    return result;
  }, [filtered, hasGroups, isFiltering, allGroups]);

  return (
    <div className="space-y-4">
      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {allTags.map((tag) => {
            const on = activeTagIds.has(tag.id);
            return (
              <button
                key={tag.id}
                onClick={() =>
                  setActiveTagIds((prev) => {
                    const n = new Set(prev);
                    if (n.has(tag.id)) n.delete(tag.id);
                    else n.add(tag.id);
                    return n;
                  })
                }
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  on
                    ? "text-white"
                    : "border bg-background text-foreground hover:bg-accent"
                }`}
                style={
                  on
                    ? { backgroundColor: tag.color }
                    : { borderColor: `${tag.color}40` }
                }
              >
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: tag.color }}
                />
                {tag.name}
              </button>
            );
          })}
          {activeTagIds.size > 0 && (
            <button
              onClick={() => setActiveTagIds(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {sections && !isFiltering ? (
        // Sectioned view: grouped projects in containers, ungrouped flat
        <div className="space-y-6">
          {sections.map((section) =>
            section.group ? (
              <div
                key={section.group.id}
                className="rounded-xl border bg-muted/30 p-4"
              >
                <div className="flex items-center gap-2 mb-3">
                  <span
                    className="size-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: section.group.color }}
                  />
                  <h2 className="text-sm font-semibold">
                    {section.group.name}
                  </h2>
                  <AddToGroupPopover
                    group={section.group}
                    allProjects={projects}
                    groupProjects={section.projects}
                    orgId={orgId}
                    onMoved={() => router.refresh()}
                  />
                  <span className="text-xs text-muted-foreground ml-auto">
                    {section.projects.length} project
                    {section.projects.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {section.projects.map((project) => (
                    <ProjectCard key={project.id} project={project} />
                  ))}
                </div>
              </div>
            ) : (
              <div key="__ungrouped">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {section.projects.map((project) => (
                    <ProjectCard key={project.id} project={project} />
                  ))}
                </div>
              </div>
            )
          )}
        </div>
      ) : (
        // Flat view: when filtering or no groups
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}

      {filtered.length === 0 && projects.length > 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <p className="text-sm text-muted-foreground">
            No projects match the current filters.
          </p>
          <button
            onClick={() => setActiveTagIds(new Set())}
            className="text-sm text-primary hover:underline"
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
