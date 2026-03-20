"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { X, FolderOpen } from "lucide-react";
import { detectProjectIcon } from "@/lib/ui/project-icon";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

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

export function ProjectGrid({ projects, allTags, allGroups, orgId }: ProjectGridProps) {
  const router = useRouter();
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState<{ projectIds: string[] } | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<string | null>(null);
  const groupNameRef = useRef<HTMLInputElement>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holdTarget, setHoldTarget] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  useEffect(() => {
    const interval = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(interval);
  }, [router]);

  const filteredProjects = useMemo(() => {
    return projects.filter((p) => {
      if (activeTagIds.size > 0) {
        const ids = new Set(p.projectTags.map((pt) => pt.tag.id));
        for (const tagId of activeTagIds) if (!ids.has(tagId)) return false;
      }
      return true;
    });
  }, [projects, activeTagIds]);

  const { ungrouped, groupedMap } = useMemo(() => {
    const gMap = new Map<string, { group: Group; projects: ProjectWithRelations[] }>();
    const ung: ProjectWithRelations[] = [];
    for (const p of filteredProjects) {
      if (p.projectGroups.length > 0) {
        const g = p.projectGroups[0].group;
        if (!gMap.has(g.id)) gMap.set(g.id, { group: g, projects: [] });
        gMap.get(g.id)!.projects.push(p);
      } else {
        ung.push(p);
      }
    }
    return { ungrouped: ung, groupedMap: gMap };
  }, [filteredProjects]);

  const sortableIds = ungrouped
    .filter((p) => !creatingGroup?.projectIds.includes(p.id))
    .map((p) => p.id);

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragOver(event: DragOverEvent) {
    const over = event.over?.id as string | undefined;
    setOverId(over || null);

    // Start hold timer for grouping
    if (over && over !== activeId && !over.startsWith("group-")) {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      holdTimerRef.current = setTimeout(() => setHoldTarget(over), 800);
    } else {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      setHoldTarget(null);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    const sourceId = event.active.id as string;
    const targetId = event.over?.id as string | undefined;
    setActiveId(null);
    setOverId(null);

    if (!targetId || sourceId === targetId) {
      setHoldTarget(null);
      return;
    }

    // Group mode — was holding
    if (holdTarget === targetId) {
      setHoldTarget(null);
      const sp = projects.find((p) => p.id === sourceId);
      if (sp?.projectGroups.length) {
        for (const pg of sp.projectGroups) await rmGroup(sourceId, pg.group.id);
      }
      const tp = projects.find((p) => p.id === targetId);
      if (tp?.projectGroups.length) {
        for (const pg of tp.projectGroups) await rmGroup(targetId, pg.group.id);
      }
      setCreatingGroup({ projectIds: [sourceId, targetId] });
      setNewGroupName("");
      setTimeout(() => groupNameRef.current?.focus(), 100);
      return;
    }
    setHoldTarget(null);

    // Drop on group
    if (targetId.startsWith("group-")) {
      const groupId = targetId.replace("group-", "");
      const sp = projects.find((p) => p.id === sourceId);
      if (sp?.projectGroups.length) {
        for (const pg of sp.projectGroups) await rmGroup(sourceId, pg.group.id);
      }
      await addGroup(sourceId, groupId);
      return;
    }

    // Reorder
    const sp = projects.find((p) => p.id === sourceId);
    if (sp?.projectGroups.length) {
      for (const pg of sp.projectGroups) await rmGroup(sourceId, pg.group.id);
    }

    const visible = ungrouped.filter((p) => p.id !== sourceId && !creatingGroup?.projectIds.includes(p.id));
    const newOrder = visible.map((p) => p.id);
    const targetIdx = newOrder.indexOf(targetId);
    if (targetIdx !== -1) {
      newOrder.splice(targetIdx + 1, 0, sourceId);
    } else {
      newOrder.push(sourceId);
    }

    try {
      await fetch(`/api/v1/organizations/${orgId}/projects/sort`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: newOrder }),
      });
      router.refresh();
    } catch { toast.error("Failed to reorder"); }
  }

  async function addGroup(projectId: string, groupId: string) {
    await fetch(`/api/v1/organizations/${orgId}/projects/${projectId}/groups`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId }),
    });
    router.refresh();
  }

  async function rmGroup(projectId: string, groupId: string) {
    await fetch(`/api/v1/organizations/${orgId}/projects/${projectId}/groups`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId }),
    });
    const entry = groupedMap.get(groupId);
    if (entry && entry.projects.length <= 2) {
      const remaining = entry.projects.find((p) => p.id !== projectId);
      if (remaining) {
        await fetch(`/api/v1/organizations/${orgId}/projects/${remaining.id}/groups`, {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ groupId }),
        });
      }
      await fetch(`/api/v1/organizations/${orgId}/groups`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: groupId }),
      });
    }
    router.refresh();
  }

  async function handleCreateGroup() {
    if (!creatingGroup) return;
    const name = newGroupName.trim() || creatingGroup.projectIds
      .map((pid) => projects.find((p) => p.id === pid)?.displayName).filter(Boolean).join(" & ");
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/groups`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error || "Failed"); return; }
      const { group } = await res.json();
      for (const pid of creatingGroup.projectIds) await addGroup(pid, group.id);
      setCreatingGroup(null);
      setNewGroupName("");
      router.refresh();
    } catch { toast.error("Failed to create group"); }
  }

  async function handleDeleteGroup(groupId: string) {
    const entry = groupedMap.get(groupId);
    if (entry) { for (const p of entry.projects) await rmGroup(p.id, groupId); }
    await fetch(`/api/v1/organizations/${orgId}/groups`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: groupId }),
    });
    setConfirmDeleteGroupId(null);
    router.refresh();
  }

  const activeProject = activeId ? projects.find((p) => p.id === activeId) : null;

  return (
    <div className="space-y-4">
      {/* Tag filters */}
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

      {/* Create group inline */}
      {creatingGroup && (
        <div className="rounded-lg border border-dashed bg-card/30 p-2 inline-flex flex-col gap-2">
          <div className="flex items-center gap-2 px-1">
            <input ref={groupNameRef} value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateGroup(); if (e.key === "Escape") setCreatingGroup(null); }}
              onBlur={() => handleCreateGroup()} placeholder="Group name"
              className="bg-transparent border-none text-xs font-medium text-foreground placeholder:text-muted-foreground/40 focus:outline-none flex-1" />
            <button onClick={() => setCreatingGroup(null)} className="text-muted-foreground/40 hover:text-muted-foreground p-0.5">
              <X className="size-3" />
            </button>
          </div>
          <div className="flex gap-2">
            {creatingGroup.projectIds.map((pid) => {
              const p = projects.find((pr) => pr.id === pid);
              return p ? <ProjectCardStatic key={p.id} project={p} compact /> : null;
            })}
          </div>
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter}
        onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* Groups */}
          {Array.from(groupedMap.entries()).map(([groupId, { group, projects: gp }]) => (
            <div key={groupId}
              className="rounded-lg border bg-card/30 p-2 space-y-2 border-border/50"
              style={{ gridColumn: `span ${Math.min(gp.length, 3)}` }}
            >
              <div className="flex items-center gap-2 px-1 group/header">
                <span className="text-xs font-medium text-muted-foreground">{group.name}</span>
                <span className="text-[10px] text-muted-foreground/50">{gp.length}</span>
                {confirmDeleteGroupId === groupId ? (
                  <div className="flex items-center gap-1 ml-auto">
                    <span className="text-[10px] text-muted-foreground">Ungroup?</span>
                    <button onClick={() => handleDeleteGroup(groupId)} className="text-[10px] text-status-error hover:underline">Yes</button>
                    <button onClick={() => setConfirmDeleteGroupId(null)} className="text-[10px] text-muted-foreground hover:underline">No</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmDeleteGroupId(groupId)}
                    className="opacity-0 group-hover/header:opacity-100 ml-auto p-0.5 text-muted-foreground/30 hover:text-muted-foreground transition-all">
                    <X className="size-3" />
                  </button>
                )}
              </div>
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(gp.length, 3)}, 1fr)` }}>
                {gp.map((p) => <ProjectCardStatic key={p.id} project={p} compact />)}
              </div>
            </div>
          ))}

          {/* Sortable ungrouped */}
          <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
            {sortableIds.map((id) => {
              const p = ungrouped.find((pr) => pr.id === id);
              if (!p) return null;
              return <SortableProjectCard key={id} project={p} isHoldTarget={holdTarget === id} />;
            })}
          </SortableContext>
        </div>

        <DragOverlay>
          {activeProject ? <ProjectCardStatic project={activeProject} overlay /> : null}
        </DragOverlay>
      </DndContext>

      {filteredProjects.length === 0 && projects.length > 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <p className="text-sm text-muted-foreground">No projects match the current filters.</p>
          <button onClick={() => setActiveTagIds(new Set())} className="text-sm text-primary hover:underline">Clear filters</button>
        </div>
      )}
    </div>
  );
}

// ── Sortable Card (draggable) ─────────────────────────────────────────────

function SortableProjectCard({ project, isHoldTarget }: { project: ProjectWithRelations; isHoldTarget: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}
      className={`transition-transform ${isDragging ? "opacity-30 scale-95 z-50" : ""} ${isHoldTarget ? "ring-2 ring-status-info/50 scale-105" : ""}`}>
      <ProjectCardStatic project={project} />
    </div>
  );
}

// ── Static Card (no drag, used in overlays, groups, and create preview) ──

function ProjectCardStatic({ project, compact, overlay }: { project: ProjectWithRelations; compact?: boolean; overlay?: boolean }) {
  const isRunning = project.status === "active";
  const lastDeploy = project.deployments[0];
  const primaryDomain = project.domains.find((d) => d.isPrimary) || project.domains[0];
  const icon = detectProjectIcon({ imageName: project.imageName, gitUrl: project.gitUrl, deployType: project.deployType });

  const content = (
    <div className={`squircle flex gap-3 rounded-lg border bg-card ${compact ? "p-2" : "p-3"} ${overlay ? "shadow-2xl scale-105 rotate-1" : "hover:bg-accent/50"}`}>
      {icon ? (
        <img src={icon} alt="" className={`shrink-0 opacity-60 ${compact ? "size-8" : "size-10"}`} />
      ) : (
        <div className={`shrink-0 rounded-md bg-muted/50 ${compact ? "size-8" : "size-10"}`} />
      )}
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
    </div>
  );

  if (overlay) return content;

  return (
    <Link href={`/projects/${project.id}`} className="block">
      {content}
    </Link>
  );
}
