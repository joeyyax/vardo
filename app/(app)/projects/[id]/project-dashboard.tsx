"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { format } from "date-fns";
import {
  AlertTriangle,
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
  MessageSquare,
  UserPlus,
  X,
} from "lucide-react";
import { BudgetBar } from "@/components/ui/budget-bar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProjectDialog } from "@/components/projects/project-dialog";
import { ProjectLifecycleTimeline } from "@/components/projects/project-lifecycle-timeline";
import {
  TaskDialog,
  TASK_STATUS_LABELS,
  TASK_STATUS_COLORS,
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_COLORS,
} from "@/components/projects/task-dialog";
import { KanbanBoard } from "@/components/projects/kanban-board";
import { ProjectInvitations } from "@/components/projects/project-invitations";
import { ProjectFiles } from "@/components/projects/project-files";
import { ProjectActivity } from "@/components/projects/project-activity";
import { ProjectExpenses } from "@/components/projects/project-expenses";
import { ProjectContacts } from "@/components/projects/project-contacts";
import { IntakeEmailSettings } from "@/app/(app)/settings/intake-email-settings";
import { ProjectOnboardingChecklist } from "@/components/projects/project-onboarding-checklist";
import { ProjectOffboardingPanel } from "@/components/projects/project-offboarding-panel";
import { StageGuidance } from "@/components/projects/stage-guidance";
import { ScopeTaskPrompt } from "@/components/projects/scope-task-prompt";
import { DiscussionSheet } from "@/components/ui/discussion-sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "sonner";
import { formatHoursHuman } from "@/lib/formatting";
import { getStageCapabilities } from "@/lib/project-stages";
import type { ProjectStage } from "@/lib/db/schema";
import type { DocumentContent } from "@/lib/template-engine/types";

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
  description: string | null;
  rateOverride: number | null;
  isBillable: boolean | null;
  isArchived: boolean | null;
  status: "todo" | "in_progress" | "review" | "done" | null;
  priority: "low" | "medium" | "high" | "urgent" | null;
  assignedTo: string | null;
  type?: { id: string; name: string; color: string | null; icon: string | null } | null;
  assignedToUser?: { id: string; name: string | null; email: string } | null;
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
  stage: "getting_started" | "proposal" | "agreement" | "onboarding" | "active" | "ongoing" | "offboarding" | "completed" | null;
  budgetType: "hours" | "fixed" | null;
  budgetHours: number | null;
  budgetAmountCents: number | null;
  intakeEmailToken: string | null;
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
  budgetType: string | null;
  budgetAmount: number | null;
  budgetUsedAmount: number | null;
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
  orgName: string;
  pmEnabled?: boolean;
  currentUserId?: string;
  isAdmin?: boolean;
};

type ProjectDocument = {
  id: string;
  type: "proposal" | "contract" | "change_order" | "orientation";
  status: "draft" | "sent" | "viewed" | "accepted" | "declined";
  title: string;
  content: DocumentContent;
  publicToken: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  createdAt: string;
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
    intakeEmailToken: serverProject.intakeEmailToken,
    createdAt,
    updatedAt,
    client: {
      id: serverProject.client.id,
      name: serverProject.client.name,
      color: serverProject.client.color,
    },
  };
}

export function ProjectDashboard({ project: initialProject, orgId, orgName, pmEnabled = false, currentUserId, isAdmin = false }: ProjectDashboardProps) {
  const [project, setProject] = useState(initialProject);
  const [allClients, setAllClients] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [recentEntries, setRecentEntries] = useState<RecentEntry[]>([]);
  const [projectDocuments, setProjectDocuments] = useState<ProjectDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Team members state
  const [projectMembers, setProjectMembers] = useState<{ id: string; name: string; email: string; assignedAt: string }[]>([]);
  const [orgMembers, setOrgMembers] = useState<{ id: string; name: string; email: string; role: string }[]>([]);
  const [memberPopoverOpen, setMemberPopoverOpen] = useState(false);

  // View state (board view only available when PM is enabled)
  const [taskView, setTaskView] = useState<TaskView>(pmEnabled ? "board" : "list");

  // Dialog state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);

  // Discussion sheet state
  const [discussionOpen, setDiscussionOpen] = useState(false);

  // Stage guidance → template wizard bridge
  const [guidanceSuggestedTemplateId, setGuidanceSuggestedTemplateId] = useState<string | undefined>();

  const fetchProjectMembers = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/projects/${project.id}/members`);
      if (res.ok) {
        const data = await res.json();
        setProjectMembers(data.members);
      }
    } catch (err) {
      console.error("Error fetching project members:", err);
    }
  }, [orgId, project.id]);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [statsRes, entriesRes, clientsRes, docsRes] = await Promise.all([
        fetch(`/api/v1/organizations/${orgId}/projects/${project.id}/stats`),
        fetch(`/api/v1/organizations/${orgId}/projects/${project.id}/entries?limit=10`),
        fetch(`/api/v1/organizations/${orgId}/clients`),
        fetch(`/api/v1/organizations/${orgId}/projects/${project.id}/documents`),
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

      if (docsRes.ok) {
        const docsData = await docsRes.json();
        setProjectDocuments(docsData || []);
      }

      // Also fetch project members
      await fetchProjectMembers();
    } catch (err) {
      console.error("Error fetching project data:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, project.id, fetchProjectMembers]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Fetch org members for the add-member selector (admin only)
  useEffect(() => {
    if (!isAdmin) return;
    async function fetchOrgMembers() {
      try {
        const res = await fetch(`/api/v1/organizations/${orgId}/members`);
        if (res.ok) {
          const data = await res.json();
          setOrgMembers(data.members);
        }
      } catch (err) {
        console.error("Error fetching org members:", err);
      }
    }
    fetchOrgMembers();
  }, [isAdmin, orgId]);

  async function handleAddProjectMember(userId: string) {
    const res = await fetch(`/api/v1/organizations/${orgId}/projects/${project.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (res.ok) {
      toast.success("Member added to project");
      fetchProjectMembers();
      setMemberPopoverOpen(false);
    } else {
      const data = await res.json();
      toast.error(data.error || "Failed to add member");
    }
  }

  async function handleRemoveProjectMember(userId: string) {
    const res = await fetch(`/api/v1/organizations/${orgId}/projects/${project.id}/members?userId=${userId}`, {
      method: "DELETE",
    });
    if (res.ok) {
      toast.success("Member removed from project");
      fetchProjectMembers();
    } else {
      toast.error("Failed to remove member");
    }
  }

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

  const formatHours = formatHoursHuman;

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  };

  // Stage gating
  const stage = (project.stage || "getting_started") as ProjectStage;
  const capabilities = getStageCapabilities(stage);

  // Handler for stage guidance "Create Proposal" / "Create Contract" actions
  // Scrolls to the documents section and opens the template wizard via ref
  const handleDocumentAction = useCallback(
    (type: "proposal" | "contract" | "change_order", suggestedTemplateId?: string) => {
      setGuidanceSuggestedTemplateId(suggestedTemplateId);
      // Dispatch a custom event that ProjectFiles can listen to
      window.dispatchEvent(
        new CustomEvent("open-document-wizard", { detail: { type, suggestedTemplateId } })
      );
    },
    []
  );

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
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={() => setDiscussionOpen(true)}
            className="squircle"
          >
            <MessageSquare className="size-4" />
            Discussion
          </Button>
          {capabilities.invitations && (
            <ProjectInvitations orgId={orgId} projectId={project.id} />
          )}
          {capabilities.editProject && (
            <Button
              variant="outline"
              onClick={() => setEditDialogOpen(true)}
              className="squircle"
            >
              <Edit className="size-4" />
              Edit
            </Button>
          )}
          {capabilities.newTask && (
            <Button
              onClick={() => setTaskDialogOpen(true)}
              className="squircle"
            >
              <Plus className="size-4" />
              New Task
            </Button>
          )}
        </div>
      </div>

      {/* Lifecycle timeline */}
      <Card className="squircle">
        <CardContent className="py-4 px-6">
          <ProjectLifecycleTimeline
            currentStage={(project.stage as import("@/components/projects/project-dialog").ProjectStage) || "getting_started"}
          />
        </CardContent>
      </Card>

      {/* Stage guidance */}
      <StageGuidance
        stage={stage}
        projectId={project.id}
        orgId={orgId}
        projectName={project.name}
        clientName={project.client.name}
        organizationName={orgName}
        documents={projectDocuments}
        hasActiveTasks={project.tasks.some((t) => !t.isArchived)}
        onStageAdvanced={handleProjectUpdated}
        onDocumentAction={handleDocumentAction}
      />

      {/* Onboarding checklist — shown during onboarding stage */}
      {stage === "onboarding" && (
        <ProjectOnboardingChecklist
          orgId={orgId}
          projectId={project.id}
          onComplete={handleProjectUpdated}
        />
      )}

      {/* Offboarding panel — shown during offboarding stage */}
      {stage === "offboarding" && (
        <ProjectOffboardingPanel
          orgId={orgId}
          projectId={project.id}
          onComplete={handleProjectUpdated}
        />
      )}

      {/* Project contacts */}
      <ProjectContacts
        orgId={orgId}
        projectId={project.id}
        clientId={project.clientId}
        clientName={project.client.name}
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* Stats cards — only shown when work has started */}
          {capabilities.stats && <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

            {stats?.budgetMinutes ? (() => {
              const used = stats.budgetMinutes - (stats.budgetRemaining ?? 0);
              const isFixed = stats.budgetType === "fixed";

              return (
                <Card className="squircle">
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">
                      {isFixed ? "Budget" : "Hours Budget"}
                    </CardTitle>
                    {isFixed ? (
                      <DollarSign className="size-4 text-muted-foreground" />
                    ) : (
                      <Clock className="size-4 text-muted-foreground" />
                    )}
                  </CardHeader>
                  <CardContent>
                    {isFixed && stats.budgetAmount ? (
                      <>
                        <div className="text-2xl font-bold">
                          {formatCurrency(stats.budgetAmount - (stats.budgetUsedAmount ?? 0))}
                        </div>
                        <p className="text-xs text-muted-foreground mb-2">
                          Remaining of {formatCurrency(stats.budgetAmount)}
                        </p>
                      </>
                    ) : (
                      <>
                        <div className="text-2xl font-bold">
                          {formatHours(stats.budgetRemaining ?? 0)}
                        </div>
                        <p className="text-xs text-muted-foreground mb-2">
                          Remaining of {formatHours(stats.budgetMinutes)}
                        </p>
                      </>
                    )}
                    <BudgetBar
                      budgetType={isFixed ? "fixed" : "hours"}
                      budgetValue={isFixed ? (stats.budgetAmount ?? 0) : (stats.budgetMinutes ?? 0) / 60}
                      usedValue={isFixed ? (stats.budgetUsedAmount ?? 0) : used / 60}
                    />
                    {/* Burn rate context */}
                    {(() => {
                      const projectCreatedAt = project.createdAt instanceof Date
                        ? project.createdAt.getTime()
                        : new Date(project.createdAt).getTime();
                      const weeksActive = Math.max(1,
                        Math.floor((Date.now() - projectCreatedAt) / (7 * 24 * 60 * 60 * 1000))
                      );
                      const avgMinutesPerWeek = stats.totalMinutesAllTime / weeksActive;
                      const remainingMinutes = stats.budgetRemaining ?? 0;
                      const weeksRemaining = avgMinutesPerWeek > 0
                        ? Math.round(remainingMinutes / avgMinutesPerWeek)
                        : null;

                      return (
                        <p className="text-xs text-muted-foreground mt-2">
                          Avg {formatHours(Math.round(avgMinutesPerWeek))}/week
                          {weeksRemaining !== null && remainingMinutes > 0 && (
                            <> — ~{weeksRemaining} {weeksRemaining === 1 ? "week" : "weeks"} remaining</>
                          )}
                        </p>
                      );
                    })()}
                    <Link
                      href={`/reports?tab=projects&projectId=${project.id}`}
                      className="text-xs text-primary hover:underline mt-1 inline-block"
                    >
                      View detailed breakdown
                    </Link>
                  </CardContent>
                </Card>
              );
            })() : (
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
          </div>}

          {/* Task warning banner — pre-active stages */}
          {capabilities.tasks && !capabilities.timeEntry && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800/50 dark:bg-amber-950/30 p-3">
              <p className="text-sm text-amber-800 dark:text-amber-200 flex items-center gap-2">
                <AlertTriangle className="size-4 shrink-0" />
                <span>
                  <strong>Work has not yet been approved.</strong>{" "}
                  Tasks are for planning purposes — time tracking is available once the project is active.
                </span>
              </p>
            </div>
          )}

          {/* Scope task prompt — active stage with no tasks and accepted docs */}
          {stage === "active" && project.tasks.length === 0 && (
            <ScopeTaskPrompt
              projectId={project.id}
              orgId={orgId}
              documents={projectDocuments}
              onTasksCreated={handleProjectUpdated}
            />
          )}

          {/* Tasks section */}
          {capabilities.tasks && (pmEnabled && taskView === "board" ? (
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
          ))}

          {/* Files (uploads + generated documents) */}
          {(capabilities.files || capabilities.editDocuments) && (
            <ProjectFiles
              orgId={orgId}
              projectId={project.id}
              projectName={project.name}
              clientName={project.client.name}
              organizationName={orgName}
              suggestedTemplateId={guidanceSuggestedTemplateId}
              canUpload={capabilities.files}
              canCreateDocuments={capabilities.editDocuments}
            />
          )}

          {/* Expenses */}
          {capabilities.expenses && (
            <ProjectExpenses orgId={orgId} projectId={project.id} />
          )}

          {/* Team Members */}
          <Card className="squircle">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Team</CardTitle>
              {isAdmin && (
                <Popover open={memberPopoverOpen} onOpenChange={setMemberPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="squircle">
                      <UserPlus className="mr-1.5 size-3.5" />
                      Add
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64 p-0 squircle" align="end">
                    <Command>
                      <CommandInput placeholder="Search members..." />
                      <CommandList>
                        <CommandEmpty>No available members</CommandEmpty>
                        <CommandGroup>
                          {orgMembers
                            .filter(m => !projectMembers.some(pm => pm.id === m.id))
                            .filter(m => m.role === "member")
                            .map(m => (
                              <CommandItem
                                key={m.id}
                                onSelect={() => handleAddProjectMember(m.id)}
                              >
                                <span>{m.name || m.email}</span>
                                <span className="ml-auto text-xs text-muted-foreground">{m.email}</span>
                              </CommandItem>
                            ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}
            </CardHeader>
            <CardContent>
              {projectMembers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No members assigned.{isAdmin ? " Add members to give them access to this project." : ""}
                </p>
              ) : (
                <div className="space-y-2">
                  {projectMembers.map(m => (
                    <div key={m.id} className="flex items-center justify-between text-sm">
                      <div>
                        <span className="font-medium">{m.name || "Unnamed"}</span>
                        <span className="ml-2 text-muted-foreground">{m.email}</span>
                      </div>
                      {isAdmin && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveProjectMember(m.id)}
                        >
                          <X className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {isAdmin && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Admins and owners have access to all projects automatically.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Email Intake */}
          <IntakeEmailSettings
            organizationId={orgId}
            intakeEmailToken={project.intakeEmailToken}
            canEdit={true}
            entityType="project"
            entityId={project.id}
          />

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

      <DiscussionSheet
        open={discussionOpen}
        onOpenChange={setDiscussionOpen}
        entityType="project"
        entityId={project.id}
        orgId={orgId}
        currentUserId={currentUserId || ""}
      />
    </div>
  );
}
