"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  ListTodo,
  RefreshCw,
  User,
} from "lucide-react";

type Task = {
  id: string;
  name: string;
  description: string | null;
  status: "todo" | "in_progress" | "review" | "done" | null;
  assignedTo: string | null;
};

type PortalProjectDetail = {
  id: string;
  name: string;
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
};

const TASK_STATUS_LABELS: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};

const TASK_STATUS_COLORS: Record<string, string> = {
  todo: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  in_progress: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  review: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
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
        setError(err instanceof Error ? err.message : "Something went wrong");
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
        <div className="grid gap-4 md:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg border bg-muted/50" />
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
          <p className="text-sm text-destructive">{error || "Project not found"}</p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="outline" size="sm" asChild className="squircle">
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
          variant={project.role === "contributor" ? "default" : "secondary"}
          className="squircle ml-auto"
        >
          {project.role === "contributor" ? "Contributor" : "Viewer"}
        </Badge>
      </div>

      {/* Stats */}
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
                      ? (project.stats.completedTasks / project.stats.totalTasks) * 100
                      : 0
                  }%`,
                }}
              />
            </div>
          </CardContent>
        </Card>

        {project.visibility.show_time && project.stats.totalHours !== undefined && (
          <Card className="squircle">
            <CardHeader className="pb-2">
              <CardDescription>Time Tracked</CardDescription>
              <CardTitle className="text-2xl">
                {project.stats.totalHours.toFixed(1)}h
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Total hours logged</p>
            </CardContent>
          </Card>
        )}

        <Card className="squircle">
          <CardHeader className="pb-2">
            <CardDescription>Active Tasks</CardDescription>
            <CardTitle className="text-2xl">
              {tasksByStatus.in_progress.length + tasksByStatus.review.length}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">In progress or review</p>
          </CardContent>
        </Card>
      </div>

      {/* Tasks */}
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
                Active ({tasksByStatus.in_progress.length + tasksByStatus.review.length})
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
              {tasksByStatus.in_progress.length + tasksByStatus.review.length === 0 ? (
                <p className="py-8 text-center text-muted-foreground">
                  No active tasks
                </p>
              ) : (
                [...tasksByStatus.in_progress, ...tasksByStatus.review].map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))
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
      {task.assignedTo && (
        <User className="size-4 text-muted-foreground" />
      )}
    </div>
  );
}
