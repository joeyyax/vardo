"use client";

import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, FolderOpen, Plus } from "lucide-react";
import { detectProjectIcon } from "@/lib/ui/project-icon";

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

export function ProjectGrid({ projects, allTags, allGroups, orgId }: ProjectGridProps) {
  const router = useRouter();
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const [activeGroupId, setActiveGroupId] = useState<string>("all");
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState<{ projectIds: string[] } | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const groupNameRef = useRef<HTMLInputElement>(null);

  // Poll for updates every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(interval);
  }, [router]);

  const filteredProjects = useMemo(() => {
    return projects.filter((project) => {
      if (activeTagIds.size > 0) {
        const projectTagIds = new Set(project.projectTags.map((pt) => pt.tag.id));
        for (const tagId of activeTagIds) {
          if (!projectTagIds.has(tagId)) return false;
        }
      }
      if (activeGroupId !== "all") {
        const inGroup = project.projectGroups.some((pg) => pg.group.id === activeGroupId);
        if (!inGroup) return false;
      }
      return true;
    });
  }, [projects, activeTagIds, activeGroupId]);

  // Build groups: projects organized into their groups
  const { ungrouped, groupedMap } = useMemo(() => {
    const gMap = new Map<string, { group: Group; projects: ProjectWithRelations[] }>();
    const ung: ProjectWithRelations[] = [];

    for (const project of filteredProjects) {
      if (project.projectGroups.length > 0) {
        const firstGroup = project.projectGroups[0].group;
        if (!gMap.has(firstGroup.id)) {
          gMap.set(firstGroup.id, { group: firstGroup, projects: [] });
        }
        gMap.get(firstGroup.id)!.projects.push(project);
      } else {
        ung.push(project);
      }
    }

    return { ungrouped: ung, groupedMap: gMap };
  }, [filteredProjects]);

  function toggleTag(tagId: string) {
    setActiveTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }

  // Drag handlers
  function handleDragStart(e: React.DragEvent, projectId: string) {
    setDraggingId(projectId);
    e.dataTransfer.setData("text/plain", projectId);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (targetId !== draggingId) {
      setDragOverId(targetId);
    }
  }

  function handleDragLeave() {
    setDragOverId(null);
  }

  function handleDragEnd() {
    setDraggingId(null);
    setDragOverId(null);
  }

  async function handleDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData("text/plain");
    setDragOverId(null);
    setDraggingId(null);

    if (sourceId === targetId) return;

    // Check if target is a group
    if (targetId.startsWith("group-")) {
      const groupId = targetId.replace("group-", "");
      await addToGroup(sourceId, groupId);
      return;
    }

    // Dropping on another project — create a new group
    setCreatingGroup({ projectIds: [sourceId, targetId] });
    setNewGroupName("");
    setTimeout(() => groupNameRef.current?.focus(), 100);
  }

  async function addToGroup(projectId: string, groupId: string) {
    try {
      await fetch(`/api/v1/organizations/${orgId}/projects/${projectId}/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId }),
      });
      router.refresh();
    } catch {
      toast.error("Failed to add to group");
    }
  }

  async function removeFromGroup(projectId: string, groupId: string) {
    try {
      await fetch(`/api/v1/organizations/${orgId}/projects/${projectId}/groups`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId }),
      });
      router.refresh();
    } catch {
      toast.error("Failed to remove from group");
    }
  }

  async function handleCreateGroup() {
    if (!creatingGroup || !newGroupName.trim()) return;

    try {
      // Create the group
      const res = await fetch(`/api/v1/organizations/${orgId}/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newGroupName.trim() }),
      });
      if (!res.ok) {
        toast.error("Failed to create group");
        return;
      }
      const { group } = await res.json();

      // Add both projects to it
      for (const pid of creatingGroup.projectIds) {
        await addToGroup(pid, group.id);
      }

      toast.success(`Created "${newGroupName.trim()}"`);
      setCreatingGroup(null);
      setNewGroupName("");
      router.refresh();
    } catch {
      toast.error("Failed to create group");
    }
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
                      isActive ? "text-white" : "border bg-background text-foreground hover:bg-accent"
                    }`}
                    style={isActive ? { backgroundColor: tag.color } : { borderColor: `${tag.color}40` }}
                  >
                    <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
          {(activeTagIds.size > 0 || activeGroupId !== "all") && (
            <button
              onClick={() => { setActiveTagIds(new Set()); setActiveGroupId("all"); }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Create group dialog */}
      {creatingGroup && (
        <div className="flex items-center gap-2 rounded-lg border border-status-info/30 bg-status-info-muted p-3">
          <FolderOpen className="size-4 text-status-info shrink-0" />
          <span className="text-sm text-status-info">Name this group:</span>
          <Input
            ref={groupNameRef}
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreateGroup(); if (e.key === "Escape") setCreatingGroup(null); }}
            placeholder="e.g. Production, Databases"
            className="h-8 max-w-xs"
          />
          <Button size="sm" onClick={handleCreateGroup} disabled={!newGroupName.trim()}>Create</Button>
          <Button size="sm" variant="ghost" onClick={() => setCreatingGroup(null)}><X className="size-4" /></Button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Groups */}
        {Array.from(groupedMap.entries()).map(([groupId, { group, projects: groupProjects }]) => (
          <div
            key={groupId}
            className={`squircle rounded-lg border p-3 transition-colors ${
              dragOverId === `group-${groupId}` ? "border-status-info bg-status-info-muted" : "bg-card/50"
            }`}
            onDragOver={(e) => handleDragOver(e, `group-${groupId}`)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, `group-${groupId}`)}
          >
            <button
              type="button"
              onClick={() => setOpenGroupId(openGroupId === groupId ? null : groupId)}
              className="flex items-center gap-2 w-full text-left mb-2"
            >
              <FolderOpen className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium flex-1">{group.name}</span>
              <span className="text-xs text-muted-foreground">{groupProjects.length}</span>
            </button>

            {openGroupId === groupId ? (
              <div className="space-y-2">
                {groupProjects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    draggingId={draggingId}
                    dragOverId={dragOverId}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                    compact
                  />
                ))}
              </div>
            ) : (
              <div className="flex -space-x-1">
                {groupProjects.slice(0, 4).map((project) => {
                  const icon = detectProjectIcon({ imageName: project.imageName, gitUrl: project.gitUrl, deployType: project.deployType });
                  return icon ? (
                    <img key={project.id} src={icon} alt="" className="size-6 rounded-md bg-muted p-0.5 ring-2 ring-card/50" />
                  ) : (
                    <div key={project.id} className="size-6 rounded-md bg-muted ring-2 ring-card/50" />
                  );
                })}
                {groupProjects.length > 4 && (
                  <div className="size-6 rounded-md bg-muted ring-2 ring-card/50 flex items-center justify-center text-[10px] text-muted-foreground">
                    +{groupProjects.length - 4}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Ungrouped projects */}
        {ungrouped.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            draggingId={draggingId}
            dragOverId={dragOverId}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
          />
        ))}
      </div>

      {filteredProjects.length === 0 && projects.length > 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <p className="text-sm text-muted-foreground">No projects match the current filters.</p>
          <button
            onClick={() => { setActiveTagIds(new Set()); setActiveGroupId("all"); }}
            className="text-sm text-primary hover:underline"
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}

// ── Project Card ───────────────────────────────────────────────────────────

type ProjectCardProps = {
  project: ProjectWithRelations;
  draggingId: string | null;
  dragOverId: string | null;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragOver: (e: React.DragEvent, id: string) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent, id: string) => void;
  onDragEnd: () => void;
  compact?: boolean;
};

function ProjectCard({
  project,
  draggingId,
  dragOverId,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  compact,
}: ProjectCardProps) {
  const isRunning = project.status === "active";
  const lastDeploy = project.deployments[0];
  const primaryDomain = project.domains.find((d) => d.isPrimary) || project.domains[0];
  const isDragging = draggingId === project.id;
  const isDragTarget = dragOverId === project.id && draggingId !== project.id;
  const icon = detectProjectIcon({ imageName: project.imageName, gitUrl: project.gitUrl, deployType: project.deployType });

  return (
    <Link
      href={`/projects/${project.id}`}
      draggable
      onDragStart={(e) => { e.stopPropagation(); onDragStart(e, project.id); }}
      onDragOver={(e) => onDragOver(e, project.id)}
      onDragLeave={onDragLeave}
      onDrop={(e) => { e.preventDefault(); onDrop(e, project.id); }}
      onDragEnd={onDragEnd}
      className={`squircle flex gap-3 rounded-lg border p-3 transition-all cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-40 scale-95" : ""
      } ${isDragTarget ? "border-status-info bg-status-info-muted scale-[1.02]" : "bg-card hover:bg-accent/50"
      } ${compact ? "p-2" : "p-3"}`}
    >
      {/* Icon */}
      {icon ? (
        <img src={icon} alt="" className={`shrink-0 opacity-60 ${compact ? "size-8" : "size-10"}`} />
      ) : (
        <div className={`shrink-0 rounded-md bg-muted/50 flex items-center justify-center ${compact ? "size-8" : "size-10"}`} />
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <h3 className={`font-medium truncate ${compact ? "text-sm" : ""}`}>{project.displayName}</h3>
          {isRunning ? (
            <span className="flex items-center gap-1.5 text-xs text-status-success shrink-0">
              <span className="size-1.5 rounded-full bg-status-success animate-pulse" />
              {lastDeploy?.finishedAt ? <Uptime since={lastDeploy.finishedAt} /> : "Running"}
            </span>
          ) : project.status === "error" ? (
            <span className="text-xs text-status-error shrink-0">Error</span>
          ) : (
            <span className="text-xs text-status-neutral shrink-0">Stopped</span>
          )}
        </div>
        {!compact && primaryDomain && (
          <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">{primaryDomain.domain}</p>
        )}
        {!compact && (
          <p className="text-xs text-muted-foreground/50 mt-1 truncate">
            {project.imageName || project.gitUrl?.replace("https://github.com/", "").replace(".git", "") || project.deployType}
          </p>
        )}
      </div>
    </Link>
  );
}
