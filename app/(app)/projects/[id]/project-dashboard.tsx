"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowLeft,
  Edit,
  Plus,
  Clock,
  DollarSign,
  Archive,
  ListTodo,
  Loader2,
  LayoutList,
  Kanban,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProjectDialog } from "@/components/projects/project-dialog";
import { TaskDialog } from "@/components/projects/task-dialog";
import { KanbanBoard } from "@/components/projects/kanban-board";
import { ProjectInvitations } from "@/components/projects/project-invitations";
import { ProjectFiles } from "@/components/projects/project-files";
import { ProjectActivity } from "@/components/projects/project-activity";
import { ProjectDocuments } from "@/components/projects/project-documents";
import { ProjectExpenses } from "@/components/projects/project-expenses";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

// Server-side types (Date objects from DB)
type ServerClient = {
  id: string;
  organizationId: string;
  name: string;
  color: string | null;
  rateOverride: number | null;
  isBillable: boolean | null;
};

type ServerTask = {
  id: string;
  projectId: string;
  name: string;
  rateOverride: number | null;
  isBillable: boolean | null;
  isArchived: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

type ServerProject = {
  id: string;
  clientId: string;
  name: string;
  code: string | null;
  rateOverride: number | null;
  isBillable: boolean | null;
  isArchived: boolean | null;
  stage: "lead" | "proposal_sent" | "active" | "completed" | null;
  budgetType: "hours" | "fixed" | null;
  budgetHours: number | null;
  budgetAmountCents: number | null;
  createdAt: Date;
  updatedAt: Date;
  client: ServerClient;
  tasks: ServerTask[];
};

type ProjectStats = {
  totalMinutes: number;
  totalMinutesAllTime: number;
  totalBillable: number;
  budgetMinutes: number | null;
  budgetRemaining: number | null;
  taskBreakdown: {
    id: string;
    name: string;
    minutes: number;
  }[];
};

type RecentEntry = {
  id: string;
  date: string;
  description: string | null;
  durationMinutes: number;
  task: { id: string; name: string } | null;
};

type ProjectDashboardProps = {
  project: ServerProject;
  orgId: string;
  pmEnabled?: boolean;
  currentUserId?: string;
};

type TaskView = "list" | "board";

// Convert server types to client-side types with string dates
// Handles both Date objects (from server) and strings (from JSON/props)
function toProjectType(serverProject: ServerProject & { createdAt: Date | string; updatedAt: Date | string }) {
  const createdAt = serverProject.createdAt instanceof Date
    ? serverProject.createdAt.toISOString()
    : String(serverProject.createdAt);
  const updatedAt = serverProject.updatedAt instanceof Date
    ? serverProject.updatedAt.toISOString()
    : String(serverProject.updatedAt);

  return {
    id: serverProject.id,
    clientId: serverProject.clientId,
    name: serverProject.name,
    code: serverProject.code,
    rateOverride: serverProject.rateOverride,
    isBillable: serverProject.isBillable,
    isArchived: serverProject.isArchived ?? false,
    stage: serverProject.stage,
    budgetType: serverProject.budgetType,
    budgetHours: serverProject.budgetHours,
    budgetAmountCents: serverProject.budgetAmountCents,
    createdAt,
    updatedAt,
    client: {
      id: serverProject.client.id,
      name: serverProject.client.name,
      color: serverProject.client.color,
    },
  };
}

export function ProjectDashboard({ project: initialProject, orgId, pmEnabled = false, currentUserId }: ProjectDashboardProps) {
  const [project, setProject] = useState(initialProject);
  const [allClients, setAllClients] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [recentEntries, setRecentEntries] = useState<RecentEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // View state (board view only available when PM is enabled)
  const [taskView, setTaskView] = useState<TaskView>(pmEnabled ? "board" : "list");

  // Dialog state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [statsRes, entriesRes, clientsRes] = await Promise.all([
        fetch(`/api/v1/organizations/${orgId}/projects/${project.id}/stats`),
        fetch(`/api/v1/organizations/${orgId}/projects/${project.id}/entries?limit=10`),
        fetch(`/api/v1/organizations/${orgId}/clients`),
      ]);

      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setStats(statsData);
      }

      if (entriesRes.ok) {
        const entriesData = await entriesRes.json();
        setRecentEntries(entriesData.entries || []);
      }

      if (clientsRes.ok) {
        const clientsData = await clientsRes.json();
        setAllClients(clientsData || []);
      }
    } catch (err) {
      console.error("Error fetching project data:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, project.id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleProjectUpdated = useCallback(async () => {
    // Refresh project data
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/projects/${project.id}`);
      if (response.ok) {
        const data = await response.json();
        setProject((prev) => ({ ...prev, ...data }));
      }
    } catch (err) {
      console.error("Error refreshing project:", err);
    }
    fetchData();
  }, [orgId, project.id, fetchData]);

  const formatHours = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (mins === 0) return `${hours}h`;
    return `${hours}h ${mins}m`;
  };

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link href="/projects">
            <Button variant="ghost" size="icon" className="squircle">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div className="flex items-center gap-3">
            <div
              className="size-4 rounded-full ring-2 ring-offset-2 ring-border"
              style={{ backgroundColor: project.client.color || "#94a3b8" }}
            />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">
                  {project.name}
                </h1>
                {project.code && (
                  <span className="text-sm text-muted-foreground font-mono bg-muted px-2 py-0.5 rounded">
                    {project.code}
                  </span>
                )}
                {project.isArchived && (
                  <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                    <Archive className="size-3" />
                    Archived
                  </span>
                )}
              </div>
              <Link
                href={`/clients/${project.client.id}`}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {project.client.name}
              </Link>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setEditDialogOpen(true)}
            className="squircle"
          >
            <Edit className="size-4" />
            Edit
          </Button>
          <Button
            onClick={() => setTaskDialogOpen(true)}
            className="squircle"
          >
            <Plus className="size-4" />
            New Task
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* Stats cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">This Month</CardTitle>
                <Clock className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {stats ? formatHours(stats.totalMinutes) : "0h"}
                </div>
                <p className="text-xs text-muted-foreground">
                  {stats ? `${(stats.totalMinutes / 60).toFixed(1)} hours tracked` : "No time tracked"}
                </p>
              </CardContent>
            </Card>

            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">All Time</CardTitle>
                <Clock className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {stats ? formatHours(stats.totalMinutesAllTime) : "0h"}
                </div>
                <p className="text-xs text-muted-foreground">
                  Total hours tracked
                </p>
              </CardContent>
            </Card>

            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Revenue (Month)</CardTitle>
                <DollarSign className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {stats ? formatCurrency(stats.totalBillable) : "$0"}
                </div>
                <p className="text-xs text-muted-foreground">
                  Billable this month
                </p>
              </CardContent>
            </Card>

            {stats?.budgetMinutes ? (
              <Card className="squircle">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Budget</CardTitle>
                  <Clock className="size-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {formatHours(stats.budgetRemaining ?? 0)}
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">
                    Remaining of {formatHours(stats.budgetMinutes)}
                  </p>
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{
                        width: `${Math.min(
                          100,
                          ((stats.budgetMinutes - (stats.budgetRemaining ?? 0)) /
                            stats.budgetMinutes) *
                            100
                        )}%`,
                      }}
                    />
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card className="squircle">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Tasks</CardTitle>
                  <ListTodo className="size-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {project.tasks.length}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Active tasks
                  </p>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Tasks section - full width when board view */}
          {pmEnabled && taskView === "board" ? (
            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Kanban className="size-5" />
                  Task Board
                </CardTitle>
                <div className="flex items-center gap-2">
                  <ToggleGroup
                    type="single"
                    value={taskView}
                    onValueChange={(v) => v && setTaskView(v as TaskView)}
                    size="sm"
                  >
                    <ToggleGroupItem value="list" aria-label="List view">
                      <LayoutList className="size-4" />
                    </ToggleGroupItem>
                    <ToggleGroupItem value="board" aria-label="Board view">
                      <Kanban className="size-4" />
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setTaskDialogOpen(true)}
                    className="squircle"
                  >
                    <Plus className="size-4" />
                    Add
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <KanbanBoard orgId={orgId} projectId={project.id} currentUserId={currentUserId} />
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Tasks with Hours */}
              <Card className="squircle">
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <ListTodo className="size-5" />
                    Tasks
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    {pmEnabled && (
                      <ToggleGroup
                        type="single"
                        value={taskView}
                        onValueChange={(v) => v && setTaskView(v as TaskView)}
                        size="sm"
                      >
                        <ToggleGroupItem value="list" aria-label="List view">
                          <LayoutList className="size-4" />
                        </ToggleGroupItem>
                        <ToggleGroupItem value="board" aria-label="Board view">
                          <Kanban className="size-4" />
                        </ToggleGroupItem>
                      </ToggleGroup>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setTaskDialogOpen(true)}
                      className="squircle"
                    >
                      <Plus className="size-4" />
                      Add
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {project.tasks.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      No tasks yet. Create one to organize your work.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {project.tasks.map((task) => {
                        const taskStats = stats?.taskBreakdown.find(
                          (t) => t.id === task.id
                        );
                        return (
                          <div
                            key={task.id}
                            className="flex items-center justify-between p-3 rounded-lg border"
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{task.name}</span>
                            </div>
                            <span className="text-sm text-muted-foreground">
                              {taskStats ? formatHours(taskStats.minutes) : "0h"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Recent Entries */}
            <Card className="squircle">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="size-5" />
                  Recent Entries
                </CardTitle>
              </CardHeader>
              <CardContent>
                {recentEntries.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No time entries yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {recentEntries.map((entry) => (
                      <Link
                        key={entry.id}
                        href={`/track?date=${entry.date}&entry=${entry.id}`}
                        className="flex items-start justify-between gap-4 text-sm p-2 -mx-2 rounded-md hover:bg-accent/50 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(entry.date + "T12:00:00"), "MMM d")}
                            </span>
                            {entry.task && (
                              <span className="text-xs bg-muted px-1.5 py-0.5 rounded truncate">
                                {entry.task.name}
                              </span>
                            )}
                          </div>
                          {entry.description && (
                            <p className="text-muted-foreground truncate mt-0.5">
                              {entry.description}
                            </p>
                          )}
                        </div>
                        <span className="font-medium shrink-0">
                          {formatHours(entry.durationMinutes)}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            </div>
          )}

          {/* Documents and Files */}
          <div className="grid gap-6 lg:grid-cols-2">
            <ProjectDocuments orgId={orgId} projectId={project.id} />
            <ProjectFiles orgId={orgId} projectId={project.id} />
          </div>

          {/* Expenses and Client Access */}
          <div className="grid gap-6 lg:grid-cols-2">
            <ProjectExpenses orgId={orgId} projectId={project.id} />
            <ProjectInvitations orgId={orgId} projectId={project.id} />
          </div>

          {/* Activity Log */}
          <ProjectActivity orgId={orgId} projectId={project.id} />
        </>
      )}

      {/* Dialogs */}
      <ProjectDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        project={toProjectType(project)}
        orgId={orgId}
        clients={allClients.length > 0 ? allClients : [{ id: project.client.id, name: project.client.name, color: project.client.color }]}
        onSuccess={handleProjectUpdated}
      />

      <TaskDialog
        open={taskDialogOpen}
        onOpenChange={setTaskDialogOpen}
        task={null}
        projectId={project.id}
        orgId={orgId}
        onSuccess={fetchData}
        pmEnabled={pmEnabled}
        currentUserId={currentUserId}
      />
    </div>
  );
}
