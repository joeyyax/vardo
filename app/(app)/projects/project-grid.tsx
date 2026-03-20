"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { X, Pencil, Loader2 } from "lucide-react";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { Label } from "@/components/ui/label";
import { detectProjectIcon } from "@/lib/ui/project-icon";
import {
  DndContext,
  closestCenter,
  pointerWithin,
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
import { useDroppable } from "@dnd-kit/core";
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
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editGroupName, setEditGroupName] = useState("");
  const [savingGroup, setSavingGroup] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTargetRef = useRef<string | null>(null);
  const [holdTarget, setHoldTarget] = useState<string | null>(null);
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);

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

  // Apply local sort order if we have one (optimistic reorder)
  const sortedUngrouped = useMemo(() => {
    if (!localOrder) return ungrouped;
    const orderMap = new Map(localOrder.map((id, i) => [id, i]));
    return [...ungrouped].sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
  }, [ungrouped, localOrder]);

  const allProjectIds = filteredProjects.map((p) => p.id);
  const sortableIds = sortedUngrouped.map((p) => p.id);

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragOver(event: DragOverEvent) {
    const over = event.over?.id as string | undefined;
    setOverId(over || null);

    // Hold timer for grouping — only restart if target changed
    if (over && over !== activeId && !over.startsWith("group-")) {
      if (holdTargetRef.current !== over) {
        holdTargetRef.current = over;
        if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
        setHoldTarget(null);
        holdTimerRef.current = setTimeout(() => {
          setHoldTarget(over);
        }, 800);
      }
    } else if (!over || over === activeId) {
      holdTargetRef.current = null;
      if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
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
      // Create group immediately with auto-derived name
      const sourceName = projects.find((p) => p.id === sourceId)?.displayName || "";
      const targetName = projects.find((p) => p.id === targetId)?.displayName || "";
      const autoName = `${sourceName} & ${targetName}`;
      try {
        const res = await fetch(`/api/v1/organizations/${orgId}/groups`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: autoName }),
        });
        if (res.ok) {
          const { group } = await res.json();
          await addGroup(sourceId, group.id);
          await addGroup(targetId, group.id);
        }
      } catch { toast.error("Failed to create group"); }
      router.refresh();
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

    // Reorder — optimistic update
    const sp = projects.find((p) => p.id === sourceId);
    if (sp?.projectGroups.length) {
      for (const pg of sp.projectGroups) await rmGroup(sourceId, pg.group.id);
    }

    const currentIds = (localOrder || ungrouped.map((p) => p.id)).filter((id) => id !== sourceId);
    const targetIdx = currentIds.indexOf(targetId);
    if (targetIdx !== -1) {
      currentIds.splice(targetIdx + 1, 0, sourceId);
    } else {
      currentIds.push(sourceId);
    }

    // Optimistic: update local order immediately
    setLocalOrder([...currentIds]);

    // Persist to server in background
    fetch(`/api/v1/organizations/${orgId}/projects/sort`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: currentIds }),
    }).then(() => {
      // Sync with server after save
      setTimeout(() => { setLocalOrder(null); router.refresh(); }, 500);
    }).catch(() => {
      setLocalOrder(null);
      toast.error("Failed to reorder");
      router.refresh();
    });
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

  async function handleSaveGroupName() {
    if (!editingGroupId || !editGroupName.trim()) return;
    setSavingGroup(true);
    // TODO: Add PATCH endpoint for groups. For now, delete and recreate.
    // This is a placeholder — ideally we'd PATCH the group name.
    setSavingGroup(false);
    setEditingGroupId(null);
    toast.info("Group rename coming soon");
  }

  const activeProject = activeId ? projects.find((p) => p.id === activeId) : null;
  const editingGroup = editingGroupId ? groupedMap.get(editingGroupId) : null;

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


      <DndContext sensors={sensors} collisionDetection={pointerWithin}
        onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* Groups */}
          {Array.from(groupedMap.entries()).map(([groupId, { group, projects: gp }]) => (
            <DroppableGroup key={groupId} groupId={groupId} group={group} projects={gp}
              isHoldTarget={holdTarget === `group-${groupId}`}
              onClickBg={() => { setEditingGroupId(groupId); setEditGroupName(group.name); }} />

          ))}

          {/* Sortable ungrouped */}
          <SortableContext items={allProjectIds} strategy={rectSortingStrategy}>
            {sortableIds.map((id) => {
              const p = sortedUngrouped.find((pr) => pr.id === id);
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

      {/* Group settings sheet */}
      <BottomSheet open={!!editingGroupId} onOpenChange={(v) => { if (!v) setEditingGroupId(null); }}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Group settings</BottomSheetTitle>
            <BottomSheetDescription>
              Rename or remove this group. Projects won't be deleted.
            </BottomSheetDescription>
          </BottomSheetHeader>
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="group-name">Name</Label>
                <Input
                  id="group-name"
                  value={editGroupName}
                  onChange={(e) => setEditGroupName(e.target.value)}
                />
              </div>
              {editingGroup && (
                <div className="space-y-2">
                  <Label>Projects ({editingGroup.projects.length})</Label>
                  <div className="space-y-1">
                    {editingGroup.projects.map((p) => (
                      <div key={p.id} className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
                        <span className="text-sm">{p.displayName}</span>
                        <button
                          onClick={async () => {
                            if (editingGroupId) await rmGroup(p.id, editingGroupId);
                            router.refresh();
                          }}
                          className="text-xs text-muted-foreground hover:text-status-error transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <BottomSheetFooter>
            <Button
              variant="outline"
              className="text-status-error hover:text-status-error"
              onClick={async () => {
                if (editingGroupId) await handleDeleteGroup(editingGroupId);
                setEditingGroupId(null);
              }}
            >
              Remove Group
            </Button>
            <Button onClick={() => setEditingGroupId(null)}>
              Done
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>
    </div>
  );
}

// ── Droppable Group ───────────────────────────────────────────────────────

function DroppableGroup({ groupId, group, projects, isHoldTarget, onClickBg }: {
  groupId: string;
  group: Group;
  projects: ProjectWithRelations[];
  isHoldTarget: boolean;
  onClickBg: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `group-${groupId}` });
  const span = Math.min(projects.length, 3);

  return (
    <div ref={setNodeRef}
      className={`rounded-lg border bg-card/30 p-2 space-y-2 cursor-pointer hover:border-border transition-colors ${
        isOver || isHoldTarget ? "border-status-info bg-status-info-muted/30" : "border-border/50"
      }`}
      style={{ gridColumn: `span ${span}` }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-project-card]")) return;
        onClickBg();
      }}
    >
      <div className="flex items-center gap-2 px-1">
        <span className="text-xs font-medium text-muted-foreground">{group.name}</span>
        <span className="text-[10px] text-muted-foreground/50">{projects.length}</span>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${span}, 1fr)` }}>
        {projects.map((p) => (
          <SortableProjectCard key={p.id} project={p} isHoldTarget={false} compact />
        ))}
      </div>
    </div>
  );
}

// ── Sortable Card (draggable) ─────────────────────────────────────────────

function SortableProjectCard({ project, isHoldTarget, compact }: { project: ProjectWithRelations; isHoldTarget: boolean; compact?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} data-project-card
      className={`transition-transform ${isDragging ? "opacity-30 scale-95 z-50" : ""} ${isHoldTarget ? "ring-2 ring-status-info/50 scale-105" : ""}`}>
      <ProjectCardStatic project={project} compact={compact} />
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
