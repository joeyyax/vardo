"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
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
  Eye,
  EyeOff,
  Link as LinkIcon,
  Upload,
  X,
  FileText,
  ImageIcon,
} from "lucide-react";
import type { Task, TaskStatus, TaskPriority, TaskType, TaskFile } from "./task-dialog";
import { TASK_STATUS_LABELS, TASK_STATUS_COLORS, TASK_PRIORITY_LABELS, TASK_PRIORITY_COLORS } from "./task-dialog";
import { toast } from "sonner";
import { z } from "zod";

const taskStatusSchema = z.enum(["todo", "in_progress", "review", "done"]);

const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

const taskSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string(),
  rateOverride: z.string(),
  isBillable: z.boolean().nullable(),
  status: taskStatusSchema.nullable(),
  priority: taskPrioritySchema.nullable(),
  typeId: z.string().nullable(),
  estimateHours: z.string(),
  prLink: z.string(),
  isClientVisible: z.boolean(),
  assignedTo: z.string().nullable(),
});

type TaskFormData = z.infer<typeof taskSchema>;

type OrgMember = {
  id: string;
  name: string | null;
  email: string;
};

type TaskDetailEditProps = {
  task: Task | null;
  orgId: string;
  projectId: string;
  pmEnabled: boolean;
  defaultStatus?: TaskStatus | null;
  onSave: () => void;
  onCancel: () => void;
};

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TaskDetailEdit({
  task,
  orgId,
  projectId,
  pmEnabled,
  defaultStatus = null,
  onSave,
  onCancel,
}: TaskDetailEditProps) {
  const [taskTypes, setTaskTypes] = useState<TaskType[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [taskFilesList, setTaskFilesList] = useState<TaskFile[]>(task?.files || []);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isEditing = !!task;

  const form = useForm<TaskFormData>({
    resolver: zodResolver(taskSchema),
    defaultValues: {
      name: task?.name || "",
      description: task?.description || "",
      rateOverride:
        task?.rateOverride !== null && task?.rateOverride !== undefined
          ? (task.rateOverride / 100).toString()
          : "",
      isBillable: task?.isBillable ?? null,
      status: task?.status ?? defaultStatus,
      priority: task?.priority ?? null,
      typeId: task?.typeId || null,
      estimateHours:
        task?.estimateMinutes !== null && task?.estimateMinutes !== undefined
          ? (task.estimateMinutes / 60).toString()
          : "",
      prLink: task?.prLink || "",
      isClientVisible: task?.isClientVisible ?? true,
      assignedTo: task?.assignedTo || null,
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

  // Fetch org members for assignment
  const fetchMembers = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/members`
      );
      if (response.ok) {
        const data = await response.json();
        setMembers(data.members || []);
      }
    } catch (err) {
      console.error("Error fetching members:", err);
    }
  }, [orgId]);

  useEffect(() => {
    if (pmEnabled) {
      fetchTaskTypes();
      fetchMembers();
    }
  }, [pmEnabled, fetchTaskTypes, fetchMembers]);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files?.length || !task) return;

    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        // 1. Create project file record + get presigned URL
        const createRes = await fetch(
          `/api/v1/organizations/${orgId}/projects/${projectId}/files`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: file.name,
              sizeBytes: file.size,
              mimeType: file.type || "application/octet-stream",
            }),
          }
        );

        if (!createRes.ok) {
          throw new Error("Failed to create file record");
        }

        const { file: fileRecord, uploadUrl } = await createRes.json();

        // 2. Upload to R2
        await fetch(uploadUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" },
        });

        // 3. Link file to task
        await fetch(
          `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${task.id}/files`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileId: fileRecord.id }),
          }
        );

        // Add to local state
        setTaskFilesList((prev) => [
          ...prev,
          {
            file: {
              id: fileRecord.id,
              name: fileRecord.name,
              mimeType: fileRecord.mimeType,
              sizeBytes: fileRecord.sizeBytes,
            },
          },
        ]);
      }

      toast.success("File uploaded");
    } catch (err) {
      console.error("File upload error:", err);
      toast.error("Failed to upload file");
    } finally {
      setIsUploading(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function handleRemoveFile(fileId: string) {
    if (!task) return;
    try {
      await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${task.id}/files`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId }),
        }
      );
      setTaskFilesList((prev) => prev.filter((tf) => tf.file.id !== fileId));
      toast.success("File removed");
    } catch {
      toast.error("Failed to remove file");
    }
  }

  async function onSubmit(data: TaskFormData) {
    setError(null);
    setIsLoading(true);

    try {
      const payload: Record<string, unknown> = {
        name: data.name,
        description: data.description || null,
        rateOverride: data.rateOverride ? parseFloat(data.rateOverride) : null,
        isBillable: data.isBillable,
        status: data.status,
        priority: data.priority,
        typeId: data.typeId || null,
        estimateMinutes: data.estimateHours
          ? Math.round(parseFloat(data.estimateHours) * 60)
          : null,
        prLink: data.prLink || null,
        isClientVisible: data.isClientVisible,
      };

      if (pmEnabled) {
        payload.assignedTo = data.assignedTo || null;
      }

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

      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }

  const isBillable = form.watch("isBillable");
  const isClientVisible = form.watch("isClientVisible");

  return (
    <Form {...form}>
      <form id="task-edit-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
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
                      value === "category" ? null : (value as TaskStatus)
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
                    {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map(
                      (statusKey) => (
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
                      )
                    )}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Category-only tasks appear in time entry dropdowns but not on
                  the board.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {pmEnabled && (
          <FormField
            control={form.control}
            name="priority"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Priority</FormLabel>
                <Select
                  value={field.value || "none"}
                  onValueChange={(value) =>
                    field.onChange(
                      value === "none" ? null : (value as TaskPriority)
                    )
                  }
                >
                  <FormControl>
                    <SelectTrigger className="squircle">
                      <SelectValue placeholder="Select priority" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="squircle">
                    <SelectItem value="none">
                      <span className="text-muted-foreground">No priority</span>
                    </SelectItem>
                    {(
                      Object.keys(TASK_PRIORITY_LABELS) as TaskPriority[]
                    ).map((p) => (
                      <SelectItem key={p} value={p}>
                        <div className="flex items-center gap-2">
                          <div
                            className={`size-2 rounded-full ${
                              TASK_PRIORITY_COLORS[p].split(" ")[0]
                            }`}
                          />
                          {TASK_PRIORITY_LABELS[p]}
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
            name="assignedTo"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Assigned to</FormLabel>
                <Select
                  value={field.value || "unassigned"}
                  onValueChange={(value) =>
                    field.onChange(value === "unassigned" ? null : value)
                  }
                >
                  <FormControl>
                    <SelectTrigger className="squircle">
                      <SelectValue placeholder="Select assignee" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="squircle">
                    <SelectItem value="unassigned">
                      <span className="text-muted-foreground">Unassigned</span>
                    </SelectItem>
                    {members.map((member) => (
                      <SelectItem key={member.id} value={member.id}>
                        {member.name || member.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                      <span className="text-muted-foreground">No type</span>
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
              <FormControl>
                <CurrencyInput {...field} />
              </FormControl>
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
                    onCheckedChange={(checked) => field.onChange(checked)}
                  />
                </FormControl>
              </div>
            </FormItem>
          )}
        />

        {/* File attachments (existing tasks only, PM enabled) */}
        {pmEnabled && isEditing && (
          <div className="space-y-3">
            <FormLabel>Attachments</FormLabel>
            {taskFilesList.length > 0 && (
              <div className="space-y-2">
                {taskFilesList.map((tf) => (
                  <div
                    key={tf.file.id}
                    className="flex items-center gap-2 text-sm p-2 rounded border bg-muted/20"
                  >
                    {tf.file.mimeType.startsWith("image/") ? (
                      <ImageIcon className="size-4 text-muted-foreground shrink-0" />
                    ) : (
                      <FileText className="size-4 text-muted-foreground shrink-0" />
                    )}
                    <span className="truncate flex-1">{tf.file.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatFileSize(tf.file.sizeBytes)}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveFile(tf.file.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileUpload}
                className="hidden"
                id="task-file-upload"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="squircle"
                disabled={isUploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {isUploading ? (
                  <Loader2 className="size-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="size-4 mr-2" />
                )}
                {isUploading ? "Uploading..." : "Attach file"}
              </Button>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </form>
    </Form>
  );
}
