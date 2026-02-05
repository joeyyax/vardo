"use client";

import { useState, useEffect, useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Loader2,
  Archive,
  ArchiveRestore,
  Eye,
  EyeOff,
  Link as LinkIcon,
} from "lucide-react";
import { TaskRelationships } from "./task-relationships";
import { TaskComments } from "./task-comments";
import { TaskTags } from "./task-tags";
import { z } from "zod";

export type TaskStatus = "todo" | "in_progress" | "review" | "done";

export type TaskType = {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
};

export type Task = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  rateOverride: number | null;
  isBillable: boolean | null;
  isArchived: boolean;
  status: TaskStatus | null;
  isRecurring: boolean | null;
  assignedTo: string | null;
  createdBy: string | null;
  position: number | null;
  typeId: string | null;
  estimateMinutes: number | null;
  prLink: string | null;
  isClientVisible: boolean;
  metadata: Record<string, unknown> | null;
  type?: TaskType | null;
  createdAt: string;
  updatedAt: string;
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};

export const TASK_STATUS_COLORS: Record<TaskStatus, string> = {
  todo: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  in_progress:
    "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  review:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
};

const taskStatusSchema = z.enum(["todo", "in_progress", "review", "done"]);

const taskSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string(),
  rateOverride: z.string(),
  isBillable: z.boolean().nullable(),
  status: taskStatusSchema.nullable(),
  typeId: z.string().nullable(),
  estimateHours: z.string(),
  prLink: z.string(),
  isClientVisible: z.boolean(),
});

type TaskFormData = z.infer<typeof taskSchema>;

type TaskDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task | null;
  orgId: string;
  projectId: string;
  onSuccess: () => void;
  pmEnabled?: boolean;
  defaultStatus?: TaskStatus | null;
  currentUserId?: string;
};

export function TaskDialog({
  open,
  onOpenChange,
  task,
  orgId,
  projectId,
  onSuccess,
  pmEnabled = false,
  defaultStatus = null,
  currentUserId,
}: TaskDialogProps) {
  const [taskTypes, setTaskTypes] = useState<TaskType[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = !!task;

  const form = useForm<TaskFormData>({
    resolver: zodResolver(taskSchema),
    defaultValues: {
      name: "",
      description: "",
      rateOverride: "",
      isBillable: null,
      status: null,
      typeId: null,
      estimateHours: "",
      prLink: "",
      isClientVisible: true,
    },
  });

  // Fetch task types for the org
  const fetchTaskTypes = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/task-types`
      );
      if (response.ok) {
        const data = await response.json();
        setTaskTypes(data);
      }
    } catch (err) {
      console.error("Error fetching task types:", err);
    }
  }, [orgId]);

  useEffect(() => {
    if (open && pmEnabled) {
      fetchTaskTypes();
    }
  }, [open, pmEnabled, fetchTaskTypes]);

  // Reset form when dialog opens or task changes
  useEffect(() => {
    if (open) {
      if (task) {
        form.reset({
          name: task.name,
          description: task.description || "",
          rateOverride:
            task.rateOverride !== null
              ? (task.rateOverride / 100).toString()
              : "",
          isBillable: task.isBillable,
          status: task.status,
          typeId: task.typeId,
          estimateHours:
            task.estimateMinutes !== null
              ? (task.estimateMinutes / 60).toString()
              : "",
          prLink: task.prLink || "",
          isClientVisible: task.isClientVisible ?? true,
        });
      } else {
        form.reset({
          name: "",
          description: "",
          rateOverride: "",
          isBillable: null,
          status: defaultStatus,
          typeId: null,
          estimateHours: "",
          prLink: "",
          isClientVisible: true,
        });
      }
      setError(null);
    }
  }, [open, task, defaultStatus, form]);

  async function onSubmit(data: TaskFormData) {
    setError(null);
    setIsLoading(true);

    try {
      const payload = {
        name: data.name,
        description: data.description || null,
        rateOverride: data.rateOverride ? parseFloat(data.rateOverride) : null,
        isBillable: data.isBillable,
        status: data.status,
        typeId: data.typeId || null,
        estimateMinutes: data.estimateHours
          ? Math.round(parseFloat(data.estimateHours) * 60)
          : null,
        prLink: data.prLink || null,
        isClientVisible: data.isClientVisible,
      };

      const url = isEditing
        ? `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${task!.id}`
        : `/api/v1/organizations/${orgId}/projects/${projectId}/tasks`;

      const response = await fetch(url, {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const responseData = await response.json();
        throw new Error(responseData.error || "Something went wrong");
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }

  const handleArchiveToggle = async () => {
    if (!task) return;
    setIsArchiving(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${task.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isArchived: !task.isArchived }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Something went wrong");
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsArchiving(false);
    }
  };

  const handleDelete = async () => {
    if (!task) return;
    setIsDeleting(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${task.id}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Something went wrong");
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsDeleting(false);
    }
  };

  const isDisabled = isLoading || isArchiving || isDeleting;
  const isBillable = form.watch("isBillable");
  const isClientVisible = form.watch("isClientVisible");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle sm:max-w-md max-h-[90vh] overflow-y-auto">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <DialogHeader>
              <DialogTitle>
                {isEditing ? "Edit task" : "New task"}
              </DialogTitle>
              <DialogDescription>
                {isEditing
                  ? "Update task details or manage its status."
                  : "Create a new task for this project."}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-5 py-6">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="Task name"
                        autoFocus
                        className="squircle"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {pmEnabled && (
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          placeholder="Add details or notes..."
                          rows={3}
                          className="squircle resize-none"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {pmEnabled && (
                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Status</FormLabel>
                      <Select
                        value={field.value || "category"}
                        onValueChange={(value) =>
                          field.onChange(
                            value === "category"
                              ? null
                              : (value as TaskStatus)
                          )
                        }
                      >
                        <FormControl>
                          <SelectTrigger className="squircle">
                            <SelectValue placeholder="Select status" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="squircle">
                          <SelectItem value="category">
                            <span className="text-muted-foreground">
                              Category only
                            </span>
                          </SelectItem>
                          {(
                            Object.keys(TASK_STATUS_LABELS) as TaskStatus[]
                          ).map((statusKey) => (
                            <SelectItem key={statusKey} value={statusKey}>
                              <div className="flex items-center gap-2">
                                <div
                                  className={`size-2 rounded-full ${
                                    TASK_STATUS_COLORS[statusKey].split(" ")[0]
                                  }`}
                                />
                                {TASK_STATUS_LABELS[statusKey]}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Category-only tasks appear in time entry dropdowns but
                        not on the board.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {pmEnabled && taskTypes.length > 0 && (
                <FormField
                  control={form.control}
                  name="typeId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Type</FormLabel>
                      <Select
                        value={field.value || "none"}
                        onValueChange={(value) =>
                          field.onChange(value === "none" ? null : value)
                        }
                      >
                        <FormControl>
                          <SelectTrigger className="squircle">
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="squircle">
                          <SelectItem value="none">
                            <span className="text-muted-foreground">
                              No type
                            </span>
                          </SelectItem>
                          {taskTypes.map((type) => (
                            <SelectItem key={type.id} value={type.id}>
                              <div className="flex items-center gap-2">
                                {type.color && (
                                  <div
                                    className="size-2 rounded-full"
                                    style={{ backgroundColor: type.color }}
                                  />
                                )}
                                {type.name}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {pmEnabled && (
                <FormField
                  control={form.control}
                  name="estimateHours"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Time estimate (hours)</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min="0"
                          step="0.5"
                          placeholder="e.g. 4"
                          className="squircle"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {pmEnabled && (
                <FormField
                  control={form.control}
                  name="prLink"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>PR / Code link</FormLabel>
                      <div className="relative">
                        <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                        <FormControl>
                          <Input
                            {...field}
                            type="url"
                            placeholder="https://github.com/..."
                            className="squircle pl-9"
                          />
                        </FormControl>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {pmEnabled && (
                <FormField
                  control={form.control}
                  name="isClientVisible"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between gap-4">
                      <div className="grid gap-1">
                        <FormLabel>Client visibility</FormLabel>
                        <FormDescription>
                          {field.value
                            ? "Clients can see this task in the portal."
                            : "This task is hidden from clients."}
                        </FormDescription>
                      </div>
                      <div className="flex items-center gap-2">
                        {field.value ? (
                          <Eye className="size-4 text-muted-foreground" />
                        ) : (
                          <EyeOff className="size-4 text-muted-foreground" />
                        )}
                        <FormControl>
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                      </div>
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="rateOverride"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Hourly rate override</FormLabel>
                    <FormDescription>
                      Leave blank to inherit from project or client.
                    </FormDescription>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        $
                      </span>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          className="squircle pl-7"
                        />
                      </FormControl>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="isBillable"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between gap-4">
                    <div className="grid gap-1">
                      <FormLabel>Billable</FormLabel>
                      <FormDescription>
                        {field.value === null
                          ? "Inherits from project settings."
                          : field.value
                            ? "Time tracked is billable."
                            : "Time tracked is not billable."}
                      </FormDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => field.onChange(null)}
                        className={`text-xs px-2 py-1 rounded transition-colors ${
                          field.value === null
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Inherit
                      </button>
                      <FormControl>
                        <Switch
                          checked={field.value === true}
                          onCheckedChange={(checked) =>
                            field.onChange(checked)
                          }
                        />
                      </FormControl>
                    </div>
                  </FormItem>
                )}
              />

              {task?.isArchived && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-md">
                  <Archive className="size-4" />
                  <span>This task is archived.</span>
                </div>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>

            {pmEnabled && isEditing && task && (
              <div className="border-t pt-6">
                <h4 className="text-sm font-medium mb-3">Relationships</h4>
                <TaskRelationships
                  orgId={orgId}
                  projectId={projectId}
                  taskId={task.id}
                  onUpdate={onSuccess}
                />
              </div>
            )}

            {pmEnabled && isEditing && task && (
              <div className="border-t pt-6">
                <h4 className="text-sm font-medium mb-3">Tags</h4>
                <TaskTags
                  orgId={orgId}
                  projectId={projectId}
                  taskId={task.id}
                  onUpdate={onSuccess}
                />
              </div>
            )}

            {pmEnabled && isEditing && task && currentUserId && (
              <div className="border-t pt-6">
                <h4 className="text-sm font-medium mb-3">Comments</h4>
                <TaskComments
                  orgId={orgId}
                  projectId={projectId}
                  taskId={task.id}
                  currentUserId={currentUserId}
                  onUpdate={onSuccess}
                />
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              {isEditing && (
                <div className="flex gap-2 mr-auto">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleArchiveToggle}
                    disabled={isDisabled}
                    className="squircle"
                  >
                    {isArchiving && (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    {task?.isArchived ? (
                      <>
                        <ArchiveRestore className="size-4" />
                        Unarchive
                      </>
                    ) : (
                      <>
                        <Archive className="size-4" />
                        Archive
                      </>
                    )}
                  </Button>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={isDisabled}
                        className="squircle"
                      >
                        {isDeleting && (
                          <Loader2 className="size-4 animate-spin" />
                        )}
                        Delete
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="squircle">
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete task?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently delete &quot;{task?.name}&quot;
                          and all associated time entries. This action cannot be
                          undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="squircle">
                          Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleDelete}
                          className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              )}

              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isDisabled}
                className="squircle"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isDisabled} className="squircle">
                {isLoading && <Loader2 className="size-4 animate-spin" />}
                {isEditing ? "Save changes" : "Create task"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
