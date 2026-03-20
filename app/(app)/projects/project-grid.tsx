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
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [groupTargetId, setGroupTargetId] = useState<string | null>(null);
  const groupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [creatingGroup, setCreatingGroup] = useState<{ projectIds: string[] } | null>(null);
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<string | null>(null);
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

  // Drag handlers — iOS-style: cards shift to make a gap
  function handleDragStart(e: React.DragEvent, projectId: string) {
    setDraggingId(projectId);
    e.dataTransfer.setData("text/plain", projectId);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleCardDragOver(e: React.DragEvent, targetId: string, index: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (targetId === draggingId) return;

    // Determine if cursor is in left or right half of the card
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const insertAt = x < rect.width / 2 ? index : index + 1;
    setDropIndex(insertAt);

    // Start group timer — if hovering center for 600ms, switch to group mode
    if (groupTimerRef.current) clearTimeout(groupTimerRef.current);
    const centerPct = x / rect.width;
    if (centerPct > 0.3 && centerPct < 0.7) {
      groupTimerRef.current = setTimeout(() => {
        setGroupTargetId(targetId);
        setDropIndex(null);
      }, 600);
    } else {
      setGroupTargetId(null);
    }
  }

  function handleGridDragOver(e: React.DragEvent) {
    e.preventDefault();
    // If dragging over empty space after all cards, set drop index to end
    if (!e.defaultPrevented && draggingId) {
      const visibleUngrouped = ungrouped.filter((p) => p.id !== draggingId && !creatingGroup?.projectIds.includes(p.id));
      setDropIndex(visibleUngrouped.length);
    }
  }

  function handleDragLeave() {
    if (groupTimerRef.current) clearTimeout(groupTimerRef.current);
    setDropIndex(null);
    setGroupTargetId(null);
  }

  function handleDragEnd() {
    if (groupTimerRef.current) clearTimeout(groupTimerRef.current);
    setDraggingId(null);
    setDropIndex(null);
    setGroupTargetId(null);
  }

  async function handleDrop(e: React.DragEvent, targetId?: string) {
    e.preventDefault();
    e.stopPropagation();
    const sourceId = e.dataTransfer.getData("text/plain");
    const currentDropIndex = dropIndex;
    const currentGroupTarget = groupTargetId;

    if (groupTimerRef.current) clearTimeout(groupTimerRef.current);
    setDraggingId(null);
    setDropIndex(null);
    setGroupTargetId(null);

    if (!sourceId) return;

    // Drop onto existing group folder
    if (targetId?.startsWith("group-")) {
      const groupId = targetId.replace("group-", "");
      // Remove from old group first
      const sourceProject = projects.find((p) => p.id === sourceId);
      if (sourceProject?.projectGroups.length) {
        for (const pg of sourceProject.projectGroups) {
          await removeFromGroup(sourceId, pg.group.id);
        }
      }
      await addToGroup(sourceId, groupId);
      return;
    }

    // Group mode — held over a card long enough
    if (currentGroupTarget && currentGroupTarget !== sourceId) {
      const sourceProject = projects.find((p) => p.id === sourceId);
      if (sourceProject?.projectGroups.length) {
        for (const pg of sourceProject.projectGroups) await removeFromGroup(sourceId, pg.group.id);
      }
      const targetProject = projects.find((p) => p.id === currentGroupTarget);
      if (targetProject?.projectGroups.length) {
        for (const pg of targetProject.projectGroups) await removeFromGroup(currentGroupTarget, pg.group.id);
      }
      setCreatingGroup({ projectIds: [sourceId, currentGroupTarget] });
      setNewGroupName("");
      setTimeout(() => groupNameRef.current?.focus(), 100);
      return;
    }

    // Reorder mode
    if (currentDropIndex !== null) {
      const sourceProject = projects.find((p) => p.id === sourceId);
      if (sourceProject?.projectGroups.length) {
        for (const pg of sourceProject.projectGroups) await removeFromGroup(sourceId, pg.group.id);
      }

      const visibleUngrouped = ungrouped.filter((p) => p.id !== sourceId && !creatingGroup?.projectIds.includes(p.id));
      const newOrder = [...visibleUngrouped.map((p) => p.id)];
      newOrder.splice(currentDropIndex, 0, sourceId);

      try {
        await fetch(`/api/v1/organizations/${orgId}/projects/sort`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: newOrder }),
        });
        router.refresh();
      } catch {
        toast.error("Failed to reorder");
      }
    }
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

      // If only one project remains in the group, dissolve the group
      const groupEntry = groupedMap.get(groupId);
      if (groupEntry && groupEntry.projects.length <= 2) {
        // After removing one, only 1 remains — dissolve
        const remaining = groupEntry.projects.find((p) => p.id !== projectId);
        if (remaining) {
          await fetch(`/api/v1/organizations/${orgId}/projects/${remaining.id}/groups`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groupId }),
          });
        }
        await fetch(`/api/v1/organizations/${orgId}/groups`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: groupId }),
        });
      }

      router.refresh();
    } catch {
      toast.error("Failed to remove from group");
    }
  }

  async function handleCreateGroup() {
    if (!creatingGroup) return;

    // Auto-derive name from project names if blank
    const groupName = newGroupName.trim() || creatingGroup.projectIds
      .map((pid) => projects.find((p) => p.id === pid)?.displayName)
      .filter(Boolean)
      .join(" & ");

    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: groupName }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to create group");
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

  async function handleDeleteGroup(groupId: string) {
    try {
      // Remove all projects from the group first
      const groupEntry = groupedMap.get(groupId);
      if (groupEntry) {
        for (const p of groupEntry.projects) {
          await removeFromGroup(p.id, groupId);
        }
      }
      // Delete the group itself
      await fetch(`/api/v1/organizations/${orgId}/groups`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: groupId }),
      });
      setConfirmDeleteGroupId(null);
      toast.success("Group removed");
      router.refresh();
    } catch {
      toast.error("Failed to remove group");
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

      <div ref={gridRef} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onDragOver={handleGridDragOver}>
        {/* Pending group creation */}
        {creatingGroup && (
          <div
            className="rounded-lg border border-dashed bg-card/30 p-2 space-y-2"
            style={{ gridColumn: `span ${Math.min(creatingGroup.projectIds.length, 3)}` }}
          >
            <div className="flex items-center gap-2 px-1">
              <input
                ref={groupNameRef}
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateGroup(); if (e.key === "Escape") setCreatingGroup(null); }}
                onBlur={() => handleCreateGroup()}
                placeholder="Group name"
                className="bg-transparent border-none text-xs font-medium text-foreground placeholder:text-muted-foreground/40 focus:outline-none flex-1"
              />
              <button onClick={() => setCreatingGroup(null)} className="text-muted-foreground/40 hover:text-muted-foreground p-0.5">
                <X className="size-3" />
              </button>
            </div>
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(creatingGroup.projectIds.length, 3)}, 1fr)` }}>
              {creatingGroup.projectIds.map((pid) => {
                const p = projects.find((pr) => pr.id === pid);
                if (!p) return null;
                return (
                  <ProjectCard key={p.id} project={p} index={0} draggingId={null} dropIndex={null} groupTargetId={null}
                    onDragStart={() => {}} onDragOver={() => {}} onDragLeave={() => {}} onDrop={() => {}} onDragEnd={() => {}} compact />
                );
              })}
            </div>
          </div>
        )}

        {/* Groups as container cards */}
        {Array.from(groupedMap.entries()).map(([groupId, { group, projects: groupProjects }]) => {
          const span = Math.min(groupProjects.length, 3);
          return (
            <div
              key={groupId}
              className={`rounded-lg border bg-card/30 p-2 space-y-2 transition-colors ${
                groupTargetId === `group-${groupId}` ? "border-status-info bg-status-info-muted/50" : "border-border/50"
              }`}
              style={{ gridColumn: `span ${span}` }}
              onDragOver={(e) => { e.preventDefault(); setGroupTargetId(`group-${groupId}`); setDropIndex(null); }}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, `group-${groupId}`)}
            >
              <div className="flex items-center gap-2 px-1 group/header">
                <span className="text-xs font-medium text-muted-foreground">{group.name}</span>
                <span className="text-[10px] text-muted-foreground/50">{groupProjects.length}</span>
                {confirmDeleteGroupId === groupId ? (
                  <div className="flex items-center gap-1 ml-auto">
                    <span className="text-[10px] text-muted-foreground">Ungroup?</span>
                    <button onClick={() => handleDeleteGroup(groupId)} className="text-[10px] text-status-error hover:underline">Yes</button>
                    <button onClick={() => setConfirmDeleteGroupId(null)} className="text-[10px] text-muted-foreground hover:underline">No</button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteGroupId(groupId)}
                    className="opacity-0 group-hover/header:opacity-100 ml-auto p-0.5 text-muted-foreground/30 hover:text-muted-foreground transition-all"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${span}, 1fr)` }}>
                {groupProjects.map((project) => (
                  <ProjectCard key={project.id} project={project} index={0} draggingId={draggingId} dropIndex={null} groupTargetId={groupTargetId}
                    onDragStart={handleDragStart} onDragOver={handleCardDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} onDragEnd={handleDragEnd} compact />
                ))}
              </div>
            </div>
          );
        })}

        {/* Ungrouped projects */}
        {ungrouped
          .filter((p) => !creatingGroup?.projectIds.includes(p.id))
          .map((project, i) => (
          <ProjectCard key={project.id} project={project} index={i} draggingId={draggingId} dropIndex={dropIndex} groupTargetId={groupTargetId}
            onDragStart={handleDragStart} onDragOver={handleCardDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} onDragEnd={handleDragEnd} />
        ))}

        {/* Trailing drop gap */}
        {dropIndex !== null && draggingId && dropIndex >= ungrouped.filter((p) => p.id !== draggingId && !creatingGroup?.projectIds.includes(p.id)).length && (
          <div className="rounded-lg border-2 border-dashed border-status-info/30 bg-status-info-muted/20 min-h-[60px]" />
        )}
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
  index: number;
  draggingId: string | null;
  dropIndex: number | null;
  groupTargetId: string | null;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragOver: (e: React.DragEvent, id: string, index: number) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent, id?: string) => void;
  onDragEnd: () => void;
  compact?: boolean;
};

function ProjectCard({
  project,
  index,
  draggingId,
  dropIndex,
  groupTargetId,
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
  const isGroupTarget = groupTargetId === project.id;
  const icon = detectProjectIcon({ imageName: project.imageName, gitUrl: project.gitUrl, deployType: project.deployType });

  // Show gap before this card if drop index matches
  const showGapBefore = dropIndex === index && draggingId && draggingId !== project.id;

  return (
    <>
      {showGapBefore && (
        <div className="rounded-lg border-2 border-dashed border-status-info/30 bg-status-info-muted/20 min-h-[60px] transition-all" />
      )}
      <Link
        href={`/projects/${project.id}`}
        draggable
        onDragStart={(e) => { e.stopPropagation(); onDragStart(e, project.id); }}
        onDragOver={(e) => { e.stopPropagation(); onDragOver(e, project.id, index); }}
        onDragLeave={onDragLeave}
        onDrop={(e) => { e.stopPropagation(); onDrop(e, project.id); }}
        onDragEnd={onDragEnd}
        className={`squircle flex gap-3 rounded-lg border p-3 transition-all cursor-grab active:cursor-grabbing ${
          isDragging ? "opacity-30 scale-95" : ""
        } ${isGroupTarget ? "border-status-info bg-status-info-muted scale-[1.02] ring-2 ring-status-info/30" : "bg-card hover:bg-accent/50"
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
    </>
  );
}
