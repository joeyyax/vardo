"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ClipboardList,
  Download,
  FileText,
  HelpCircle,
  ListTodo,
  PackageOpen,
  RefreshCw,
  User,
} from "lucide-react";
import { toast } from "sonner";

type Task = {
  id: string;
  name: string;
  description: string | null;
  status: "todo" | "in_progress" | "review" | "done" | null;
  assignedTo: string | null;
};

type OnboardingItem = {
  id: string;
  label: string;
  description: string | null;
  category: string;
  isRequired: boolean;
  isCompleted: boolean;
};

type DocumentSection = {
  id: string;
  type: string;
  title: string;
  content: string;
  order: number;
};

type ProjectStage =
  | "getting_started"
  | "proposal"
  | "agreement"
  | "onboarding"
  | "active"
  | "ongoing"
  | "offboarding"
  | "completed";

type PortalProjectDetail = {
  id: string;
  name: string;
  stage: ProjectStage;
  clientName: string;
  organizationName: string;
  role: "viewer" | "contributor";
  visibility: {
    show_rates: boolean;
    show_time: boolean;
    show_costs: boolean;
  };
  tasks: Task[];
  stats: {
    totalTasks: number;
    completedTasks: number;
    totalHours?: number;
  };
  isRepeatClient: boolean;
  orientationDoc: {
    title: string;
    content: { sections: DocumentSection[] };
  } | null;
  onboardingChecklist: OnboardingItem[];
};

const TASK_STATUS_LABELS: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};

const TASK_STATUS_COLORS: Record<string, string> = {
  todo: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  in_progress:
    "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  review:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
};

// Stage definitions for the client-facing timeline
const STAGE_ORDER: ProjectStage[] = [
  "getting_started",
  "proposal",
  "agreement",
  "onboarding",
  "active",
  "ongoing",
  "offboarding",
  "completed",
];

const STAGE_LABELS: Record<ProjectStage, string> = {
  getting_started: "Getting Started",
  proposal: "Proposal",
  agreement: "Agreement",
  onboarding: "Onboarding",
  active: "Active",
  ongoing: "Ongoing",
  offboarding: "Wrapping Up",
  completed: "Complete",
};

const CLIENT_STAGE_MESSAGES: Record<
  ProjectStage,
  { description: string; hint: string | null }
> = {
  getting_started: {
    description:
      "We're getting set up and aligning on next steps for this project.",
    hint: "An orientation document may be available below with details on how we'll work together.",
  },
  proposal: {
    description: "A proposal is being prepared with scope and pricing details.",
    hint: "You'll be notified when it's ready for review.",
  },
  agreement: {
    description:
      "The proposal has been accepted. A service agreement is being finalized.",
    hint: "You'll receive the agreement to review and accept when it's ready.",
  },
  onboarding: {
    description:
      "We're setting things up before work begins. There may be items below that need your input.",
    hint: "Complete any checklist items assigned to you to help us get started faster.",
  },
  active: {
    description: "Work is underway. You can track progress on tasks below.",
    hint: null,
  },
  ongoing: {
    description: "This project is in ongoing maintenance and support.",
    hint: null,
  },
  offboarding: {
    description:
      "We're wrapping things up and preparing everything for handoff.",
    hint: "Contact us if you need data exports or migration assistance.",
  },
  completed: {
    description: "This project is complete. Thank you for working with us.",
    hint: null,
  },
};

export default function PortalProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const [project, setProject] = useState<PortalProjectDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchProject() {
      try {
        const response = await fetch(`/api/portal/projects/${projectId}`);
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("Project not found or you don't have access");
          }
          throw new Error("Failed to fetch project");
        }
        const data = await response.json();
        setProject(data);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Something went wrong"
        );
      } finally {
        setIsLoading(false);
      }
    }

    fetchProject();
  }, [projectId]);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex items-center gap-4">
          <div className="h-8 w-8 animate-pulse rounded bg-muted" />
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-16 animate-pulse rounded-lg border bg-muted/50" />
        <div className="grid gap-4 md:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-lg border bg-muted/50"
            />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-lg border bg-muted/50" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">
            {error || "Project not found"}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              asChild
              className="squircle"
            >
              <Link href="/portal">
                <ArrowLeft className="size-4" />
                Back to projects
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.location.reload()}
              className="squircle"
            >
              <RefreshCw className="size-4" />
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const stageIdx = STAGE_ORDER.indexOf(project.stage);
  const defaultMsg = CLIENT_STAGE_MESSAGES[project.stage];
  // Lighter messaging for repeat clients in early stages
  const stageMsg =
    project.isRepeatClient &&
    (project.stage === "getting_started" || project.stage === "onboarding")
      ? {
          description:
            project.stage === "getting_started"
              ? "We're kicking off a new project together. The process will look familiar."
              : "We're setting things up for this project. Since we've worked together before, some items may already be completed.",
          hint: defaultMsg.hint,
        }
      : defaultMsg;
  const showTasks =
    project.stage === "active" ||
    project.stage === "ongoing" ||
    project.stage === "offboarding" ||
    project.stage === "completed";

  const tasksByStatus = {
    todo: project.tasks.filter((t) => t.status === "todo"),
    in_progress: project.tasks.filter((t) => t.status === "in_progress"),
    review: project.tasks.filter((t) => t.status === "review"),
    done: project.tasks.filter((t) => t.status === "done"),
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild className="squircle">
          <Link href="/portal">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold">{project.name}</h1>
          <p className="text-muted-foreground">
            {project.clientName} &middot; {project.organizationName}
          </p>
        </div>
        <Badge
          variant={
            project.role === "contributor" ? "default" : "secondary"
          }
          className="squircle ml-auto"
        >
          {project.role === "contributor" ? "Contributor" : "Viewer"}
        </Badge>
      </div>

      {/* Lifecycle Timeline */}
      <LifecycleTimeline stage={project.stage} stageIdx={stageIdx} />

      {/* Stage Message */}
      <Card className="squircle">
        <CardContent className="py-4">
          <p className="text-sm text-foreground">{stageMsg.description}</p>
          {stageMsg.hint && (
            <p className="mt-1 text-sm text-muted-foreground">
              {stageMsg.hint}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Orientation Document */}
      {project.orientationDoc && (
        <OrientationSection
          doc={project.orientationDoc}
          isRepeatClient={project.isRepeatClient}
        />
      )}

      {/* Onboarding Checklist */}
      {project.stage === "onboarding" &&
        project.onboardingChecklist.length > 0 && (
          <OnboardingSection
            items={project.onboardingChecklist}
            projectId={project.id}
            role={project.role}
            onUpdate={(items) =>
              setProject((p) =>
                p ? { ...p, onboardingChecklist: items } : p
              )
            }
          />
        )}

      {/* Offboarding Info — shown during offboarding */}
      {project.stage === "offboarding" && <PortalOffboardingSection />}

      {/* Stats (shown when tasks are visible) */}
      {showTasks && (
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="squircle">
            <CardHeader className="pb-2">
              <CardDescription>Progress</CardDescription>
              <CardTitle className="text-2xl">
                {project.stats.completedTasks} / {project.stats.totalTasks}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{
                    width: `${
                      project.stats.totalTasks > 0
                        ? (project.stats.completedTasks /
                            project.stats.totalTasks) *
                          100
                        : 0
                    }%`,
                  }}
                />
              </div>
            </CardContent>
          </Card>

          {project.visibility.show_time &&
            project.stats.totalHours !== undefined && (
              <Card className="squircle">
                <CardHeader className="pb-2">
                  <CardDescription>Time Tracked</CardDescription>
                  <CardTitle className="text-2xl">
                    {project.stats.totalHours.toFixed(1)}h
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    Total hours logged
                  </p>
                </CardContent>
              </Card>
            )}

          <Card className="squircle">
            <CardHeader className="pb-2">
              <CardDescription>Active Tasks</CardDescription>
              <CardTitle className="text-2xl">
                {tasksByStatus.in_progress.length +
                  tasksByStatus.review.length}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                In progress or review
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tasks */}
      {showTasks && (
        <Card className="squircle">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ListTodo className="size-5" />
              Tasks
            </CardTitle>
            <CardDescription>
              Track progress on project tasks
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="all" className="w-full">
              <TabsList className="squircle mb-4">
                <TabsTrigger value="all" className="squircle">
                  All ({project.tasks.length})
                </TabsTrigger>
                <TabsTrigger value="active" className="squircle">
                  Active (
                  {tasksByStatus.in_progress.length +
                    tasksByStatus.review.length}
                  )
                </TabsTrigger>
                <TabsTrigger value="done" className="squircle">
                  Done ({tasksByStatus.done.length})
                </TabsTrigger>
              </TabsList>

              <TabsContent value="all" className="space-y-2">
                {project.tasks.length === 0 ? (
                  <p className="py-8 text-center text-muted-foreground">
                    No tasks yet
                  </p>
                ) : (
                  project.tasks.map((task) => (
                    <TaskRow key={task.id} task={task} />
                  ))
                )}
              </TabsContent>

              <TabsContent value="active" className="space-y-2">
                {tasksByStatus.in_progress.length +
                  tasksByStatus.review.length ===
                0 ? (
                  <p className="py-8 text-center text-muted-foreground">
                    No active tasks
                  </p>
                ) : (
                  [
                    ...tasksByStatus.in_progress,
                    ...tasksByStatus.review,
                  ].map((task) => <TaskRow key={task.id} task={task} />)
                )}
              </TabsContent>

              <TabsContent value="done" className="space-y-2">
                {tasksByStatus.done.length === 0 ? (
                  <p className="py-8 text-center text-muted-foreground">
                    No completed tasks
                  </p>
                ) : (
                  tasksByStatus.done.map((task) => (
                    <TaskRow key={task.id} task={task} />
                  ))
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// --- Sub-components ---

function LifecycleTimeline({
  stage,
  stageIdx,
}: {
  stage: ProjectStage;
  stageIdx: number;
}) {
  // Show a simplified timeline: past stages (compressed), current, next
  const visibleStages = STAGE_ORDER.filter((_, i) => {
    // Always show current stage
    if (i === stageIdx) return true;
    // Show completed stages
    if (i < stageIdx) return true;
    // Show next stage if not at the end
    if (i === stageIdx + 1) return true;
    return false;
  });

  return (
    <div className="flex items-center gap-1 overflow-x-auto py-1">
      {visibleStages.map((s, i) => {
        const idx = STAGE_ORDER.indexOf(s);
        const isCurrent = s === stage;
        const isPast = idx < stageIdx;

        return (
          <div key={s} className="flex items-center">
            {i > 0 && (
              <div
                className={`mx-1 h-px w-6 ${
                  isPast ? "bg-primary" : "bg-border"
                }`}
              />
            )}
            <div
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                isCurrent
                  ? "bg-primary text-primary-foreground"
                  : isPast
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {isPast && <Check className="size-3" />}
              {STAGE_LABELS[s]}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function OrientationSection({
  doc,
  isRepeatClient,
}: {
  doc: { title: string; content: { sections: DocumentSection[] } };
  isRepeatClient: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const sections = doc.content?.sections
    ? [...doc.content.sections].sort((a, b) => a.order - b.order)
    : [];

  return (
    <Card className="squircle">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <FileText className="size-5" />
            {doc.title}
            {isRepeatClient && (
              <Badge variant="secondary" className="squircle text-[10px]">
                Previously reviewed
              </Badge>
            )}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(!expanded)}
            className="squircle"
          >
            {expanded ? "Collapse" : "Read"}
          </Button>
        </div>
        <CardDescription>
          {isRepeatClient
            ? "You've seen this before — it covers how we work together"
            : "A guide to how we work together on this project"}
        </CardDescription>
      </CardHeader>
      {expanded && sections.length > 0 && (
        <CardContent className="space-y-4 border-t pt-4">
          {sections.map((section) => (
            <div key={section.id}>
              <h3 className="text-sm font-semibold mb-1">{section.title}</h3>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                {section.content}
              </p>
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
}

function OnboardingSection({
  items,
  projectId,
  role,
  onUpdate,
}: {
  items: OnboardingItem[];
  projectId: string;
  role: "viewer" | "contributor";
  onUpdate: (items: OnboardingItem[]) => void;
}) {
  const [toggling, setToggling] = useState<string | null>(null);

  const completedCount = items.filter((i) => i.isCompleted).length;
  const totalCount = items.length;
  const progress =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  // Group items by category
  const categories = [...new Set(items.map((i) => i.category))];

  const CATEGORY_LABELS: Record<string, string> = {
    contacts: "Contacts & Communication",
    access: "Access & Credentials",
    assets: "Assets & Materials",
    review: "Review & Confirm",
  };

  async function toggleItem(itemId: string, currentCompleted: boolean) {
    if (role !== "contributor") return;
    setToggling(itemId);

    try {
      const response = await fetch(
        `/api/portal/projects/${projectId}/onboarding/${itemId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isCompleted: !currentCompleted }),
        }
      );

      if (response.ok) {
        onUpdate(
          items.map((item) =>
            item.id === itemId
              ? { ...item, isCompleted: !currentCompleted }
              : item
          )
        );
      } else {
        toast.error("Failed to update item");
      }
    } catch {
      toast.error("Failed to update item");
    } finally {
      setToggling(null);
    }
  }

  return (
    <Card className="squircle">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="size-5" />
          Onboarding Checklist
        </CardTitle>
        <CardDescription>
          {completedCount} of {totalCount} items complete
        </CardDescription>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {categories.map((category) => (
          <div key={category}>
            <h3 className="text-sm font-semibold text-muted-foreground mb-2">
              {CATEGORY_LABELS[category] || category}
            </h3>
            <div className="space-y-2">
              {items
                .filter((item) => item.category === category)
                .map((item) => (
                  <div
                    key={item.id}
                    className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
                      role === "contributor"
                        ? "cursor-pointer hover:bg-muted/50"
                        : ""
                    } ${item.isCompleted ? "bg-muted/30" : ""}`}
                    onClick={() =>
                      role === "contributor" &&
                      !toggling &&
                      toggleItem(item.id, item.isCompleted)
                    }
                  >
                    <div
                      className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border transition-colors ${
                        item.isCompleted
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-muted-foreground/30"
                      }`}
                    >
                      {item.isCompleted && <Check className="size-3" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm font-medium ${
                            item.isCompleted
                              ? "text-muted-foreground line-through"
                              : ""
                          }`}
                        >
                          {item.label}
                        </span>
                        {item.isRequired && (
                          <Badge
                            variant="outline"
                            className="squircle text-[10px] px-1.5 py-0"
                          >
                            Required
                          </Badge>
                        )}
                      </div>
                      {item.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {item.description}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        ))}
        {role === "viewer" && (
          <p className="text-xs text-muted-foreground text-center">
            Contact your project lead to update checklist items.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function PortalOffboardingSection() {
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());

  const phases = [
    { id: "planning", title: "Planning", items: ["Decide on a target migration date", "Identify which assets you need", "Choose your new hosting provider or environment"] },
    { id: "access", title: "Access & Accounts", items: ["Confirm domain registrar access", "Verify DNS management credentials", "Document any API keys or integrations"] },
    { id: "data_export", title: "Data Export", items: ["Request your application data export", "Download exported files when ready", "Verify the export includes everything you need"] },
    { id: "environment", title: "New Environment", items: ["Provision your new server or hosting", "Install required software and dependencies", "Configure environment variables"] },
    { id: "deployment", title: "Deployment", items: ["Upload application code", "Import database backup", "Upload media files and assets"] },
    { id: "validation", title: "Validation", items: ["Test all core functionality", "Verify database content", "Check media files and integrations"] },
    { id: "cutover", title: "Cutover", items: ["Update DNS records", "Allow time for DNS propagation", "Verify SSL certificates"] },
    { id: "decommission", title: "Decommissioning", items: ["Confirm everything works for a few days", "Remove old hosting resources", "Notify stakeholders"] },
  ];

  const togglePhase = (id: string) => {
    setExpandedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {/* Data Export Info */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="size-5" />
            Application Data
          </CardTitle>
          <CardDescription>
            Your application data (source code, database, and media files) is available for export.
            Contact your project lead to request an export.
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Migration Checklist */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PackageOpen className="size-5" />
            Migration Checklist
          </CardTitle>
          <CardDescription>
            A guide for transitioning to a new environment. Work through these at your own pace.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {phases.map((phase) => {
            const isExpanded = expandedPhases.has(phase.id);
            return (
              <div key={phase.id} className="border rounded-lg">
                <button
                  type="button"
                  onClick={() => togglePhase(phase.id)}
                  className="flex items-center gap-3 w-full p-3 text-left hover:bg-muted/50 transition-colors"
                >
                  {isExpanded ? (
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="font-medium text-sm">{phase.title}</span>
                  {!isExpanded && (
                    <span className="text-xs text-muted-foreground ml-auto">
                      {phase.items.length} items
                    </span>
                  )}
                </button>
                {isExpanded && (
                  <ul className="px-3 pb-3 pl-10 space-y-1.5">
                    {phase.items.map((item, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                        <span className="mt-0.5 shrink-0">•</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Migration Assistance */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HelpCircle className="size-5" />
            Migration Assistance
          </CardTitle>
          <CardDescription>
            Need help with the transition? Contact your project lead to discuss assistance options.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
      {task.status === "done" ? (
        <CheckCircle2 className="size-5 text-emerald-600" />
      ) : (
        <Circle className="size-5 text-muted-foreground" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{task.name}</span>
          {task.status && (
            <span
              className={`text-xs px-1.5 py-0.5 rounded ${TASK_STATUS_COLORS[task.status]}`}
            >
              {TASK_STATUS_LABELS[task.status]}
            </span>
          )}
        </div>
        {task.description && (
          <p className="text-sm text-muted-foreground truncate mt-0.5">
            {task.description}
          </p>
        )}
      </div>
      {task.assignedTo && <User className="size-4 text-muted-foreground" />}
    </div>
  );
}
