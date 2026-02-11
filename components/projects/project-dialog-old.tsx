"use client";

import { useState, useEffect } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Loader2, Archive, ArchiveRestore } from "lucide-react";
import { z } from "zod";

export type Client = {
  id: string;
  name: string;
  color: string | null;
};

export type ProjectStage = "lead" | "proposal_sent" | "active" | "completed";
export type BudgetType = "hours" | "fixed";

export type Project = {
  id: string;
  clientId: string;
  name: string;
  code: string | null;
  rateOverride: number | null;
  isBillable: boolean | null;
  isArchived: boolean;
  stage: ProjectStage | null;
  budgetType: BudgetType | null;
  budgetHours: number | null;
  budgetAmountCents: number | null;
  createdAt: string;
  updatedAt: string;
  client: Client;
};

export const PROJECT_STAGE_LABELS: Record<ProjectStage, string> = {
  lead: "Lead",
  proposal_sent: "Proposal Sent",
  active: "Active",
  completed: "Completed",
};

export const PROJECT_STAGE_COLORS: Record<ProjectStage, string> = {
  lead: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  proposal_sent:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  active:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  completed:
    "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const projectSchema = z.object({
  clientId: z.string().min(1, "Please select a client"),
  name: z.string().min(1, "Project name is required"),
  code: z.string(),
  rateOverride: z.string(),
  isBillable: z.boolean().nullable(),
  stage: z.enum(["lead", "proposal_sent", "active", "completed"]),
});

type ProjectFormData = z.infer<typeof projectSchema>;

type ProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: Project | null;
  orgId: string;
  clients: Client[];
  defaultClientId?: string | null;
  onSuccess: () => void;
};

export function ProjectDialog({
  open,
  onOpenChange,
  project,
  orgId,
  clients,
  defaultClientId,
  onSuccess,
}: ProjectDialogProps) {
  const isEditing = !!project;

  const form = useForm<ProjectFormData>({
    resolver: zodResolver(projectSchema),
    defaultValues: {
      clientId: "",
      name: "",
      code: "",
      rateOverride: "",
      isBillable: null,
      stage: "active",
    },
  });

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens/closes or project changes
  useEffect(() => {
    if (open) {
      if (project) {
        form.reset({
          clientId: project.clientId,
          name: project.name,
          code: project.code || "",
          rateOverride:
            project.rateOverride !== null
              ? (project.rateOverride / 100).toString()
              : "",
          isBillable: project.isBillable,
          stage: project.stage || "active",
        });
      } else {
        form.reset({
          clientId: defaultClientId || "",
          name: "",
          code: "",
          rateOverride: "",
          isBillable: null,
          stage: "active",
        });
      }
      setError(null);
    }
  }, [open, project, defaultClientId, form]);

  async function onSubmit(data: ProjectFormData) {
    setError(null);
    setIsLoading(true);

    try {
      const payload = {
        clientId: data.clientId,
        name: data.name,
        code: data.code || null,
        rateOverride: data.rateOverride ? parseFloat(data.rateOverride) : null,
        isBillable: data.isBillable,
        stage: data.stage,
      };

      const url = isEditing
        ? `/api/v1/organizations/${orgId}/projects/${project.id}`
        : `/api/v1/organizations/${orgId}/projects`;

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

  const handleArchive = async () => {
    if (!project) return;

    setIsArchiving(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isArchived: !project.isArchived }),
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
    if (!project) return;

    setIsDeleting(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}`,
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

  const isDisabled = isLoading || isDeleting || isArchiving;
  const isBillable = form.watch("isBillable");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle sm:max-w-md">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <DialogHeader>
              <DialogTitle>
                {isEditing ? "Edit project" : "New project"}
              </DialogTitle>
              <DialogDescription>
                {isEditing
                  ? "Update your project details."
                  : "Add a new project to organize your work."}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-5 py-6">
              <FormField
                control={form.control}
                name="clientId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Client</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={isDisabled}
                    >
                      <FormControl>
                        <SelectTrigger className="squircle">
                          <SelectValue placeholder="Select a client" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="squircle">
                        {clients.map((client) => (
                          <SelectItem key={client.id} value={client.id}>
                            <div className="flex items-center gap-2">
                              <div
                                className="size-2.5 shrink-0 rounded-full ring-1 ring-border"
                                style={{
                                  backgroundColor: client.color || "#94a3b8",
                                }}
                              />
                              <span>{client.name}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {clients.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        You need to create a client first.
                      </p>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Project name</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="Website redesign"
                        disabled={isDisabled}
                        className="squircle"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Project code</FormLabel>
                    <FormDescription>
                      Optional short code for quick reference.
                    </FormDescription>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="ACME-001"
                        disabled={isDisabled}
                        className="squircle"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="stage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Stage</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={isDisabled}
                    >
                      <FormControl>
                        <SelectTrigger className="squircle">
                          <SelectValue placeholder="Select stage" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="squircle">
                        {(
                          Object.keys(PROJECT_STAGE_LABELS) as ProjectStage[]
                        ).map((stageKey) => (
                          <SelectItem key={stageKey} value={stageKey}>
                            <div className="flex items-center gap-2">
                              <div
                                className={`size-2 rounded-full ${
                                  PROJECT_STAGE_COLORS[stageKey].split(" ")[0]
                                }`}
                              />
                              {PROJECT_STAGE_LABELS[stageKey]}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="rateOverride"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Hourly rate override</FormLabel>
                    <FormDescription>
                      Leave blank to inherit from client.
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
                          disabled={isDisabled}
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
                  <FormItem className="flex items-center justify-between gap-3">
                    <div className="grid gap-1">
                      <FormLabel className="cursor-pointer">Billable</FormLabel>
                      <FormDescription>
                        {field.value === null
                          ? "Inherits from client settings."
                          : field.value
                            ? "Time tracked is billable."
                            : "Time tracked is not billable."}
                      </FormDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      {field.value !== null && (
                        <button
                          type="button"
                          onClick={() => field.onChange(null)}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          Reset
                        </button>
                      )}
                      <FormControl>
                        <Switch
                          checked={field.value === true}
                          onCheckedChange={(checked) => {
                            field.onChange(checked);
                          }}
                          disabled={isDisabled}
                        />
                      </FormControl>
                    </div>
                  </FormItem>
                )}
              />

              {isEditing && project?.isArchived && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
                  <p className="text-sm text-amber-800 dark:text-amber-200">
                    This project is archived. It won&apos;t appear in time entry
                    suggestions.
                  </p>
                </div>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              {isEditing && (
                <div className="mr-auto flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleArchive}
                    disabled={isDisabled}
                    className="squircle"
                  >
                    {isArchiving && (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    {project?.isArchived ? (
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
                        <AlertDialogTitle>Delete project?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently delete &quot;{project?.name}
                          &quot; and all associated tasks and time entries. This
                          action cannot be undone.
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
                {isEditing ? "Save changes" : "Create project"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
