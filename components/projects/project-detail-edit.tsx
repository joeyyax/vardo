"use client";

import { useState, useEffect } from "react";
import { useOrgMembers } from "@/hooks/use-org-members";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
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
import { z } from "zod";
import type { Project, Client, ProjectStage } from "./project-dialog";
import { PROJECT_STAGE_LABELS, PROJECT_STAGE_COLORS } from "./project-dialog";

const projectSchema = z.object({
  clientId: z.string().min(1, "Please select a client"),
  name: z.string().min(1, "Project name is required"),
  code: z.string(),
  rateOverride: z.string(),
  isBillable: z.boolean().nullable(),
  stage: z.enum([
    "getting_started",
    "proposal",
    "agreement",
    "onboarding",
    "active",
    "ongoing",
    "offboarding",
    "completed",
  ]),
  assignedTo: z.string().nullable(),
  budgetType: z.string().nullable(),
  budgetHours: z.string(),
  budgetAmount: z.string(),
});

type ProjectFormData = z.infer<typeof projectSchema>;

type ProjectDetailEditProps = {
  project: Project | null;
  orgId: string;
  clients: Client[];
  defaultClientId?: string | null;
  onSave: (projectId?: string) => void;
  onCancel: () => void;
};

export function ProjectDetailEdit({
  project,
  orgId,
  clients,
  defaultClientId,
  onSave,
  onCancel,
}: ProjectDetailEditProps) {
  const isEditing = !!project;
  const members = useOrgMembers(orgId);

  const form = useForm<ProjectFormData>({
    resolver: zodResolver(projectSchema),
    defaultValues: {
      clientId: "",
      name: "",
      code: "",
      rateOverride: "",
      isBillable: null,
      stage: "getting_started",
      assignedTo: null,
      budgetType: null,
      budgetHours: "",
      budgetAmount: "",
    },
  });

  // Reset form when project changes
  useEffect(() => {
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
        stage: project.stage || "getting_started",
        assignedTo: project.assignedTo || null,
        budgetType: project.budgetType || null,
        budgetHours:
          project.budgetHours !== null
            ? project.budgetHours.toString()
            : "",
        budgetAmount:
          project.budgetAmountCents !== null
            ? (project.budgetAmountCents / 100).toString()
            : "",
      });
    } else {
      form.reset({
        clientId: defaultClientId || "",
        name: "",
        code: "",
        rateOverride: "",
        isBillable: null,
        stage: "getting_started",
        assignedTo: null,
        budgetType: null,
        budgetHours: "",
        budgetAmount: "",
      });
    }
  }, [project, defaultClientId, form]);

  async function onSubmit(data: ProjectFormData) {
    try {
      const payload = {
        clientId: data.clientId,
        name: data.name,
        code: data.code || null,
        rateOverride: data.rateOverride ? parseFloat(data.rateOverride) : null,
        isBillable: data.isBillable,
        stage: data.stage,
        assignedTo: data.assignedTo,
        budgetType: data.budgetType || null,
        budgetHours: data.budgetHours ? parseFloat(data.budgetHours) : null,
        budgetAmountCents: data.budgetAmount
          ? Math.round(parseFloat(data.budgetAmount) * 100)
          : null,
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

      if (!isEditing) {
        const responseData = await response.json();
        onSave(responseData.id);
      } else {
        onSave();
      }
    } catch (err) {
      console.error("Error saving project:", err);
      // Error handling could be improved with toast notifications
    }
  }

  return (
    <Form {...form}>
      <form id="project-edit-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="clientId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Client</FormLabel>
              <Select
                onValueChange={field.onChange}
                value={field.value}
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
          name="assignedTo"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Owner</FormLabel>
              <Select
                value={field.value || "none"}
                onValueChange={(value) =>
                  field.onChange(value === "none" ? null : value)
                }
              >
                <FormControl>
                  <SelectTrigger className="squircle">
                    <SelectValue placeholder="Select owner" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className="squircle">
                  <SelectItem value="none">
                    <span className="text-muted-foreground">Unassigned</span>
                  </SelectItem>
                  {members.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {member.name || member.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>
                Person responsible for this project.
              </FormDescription>
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
                  />
                </FormControl>
              </div>
            </FormItem>
          )}
        />

        {/* Budget */}
        <div className="border-t pt-4 space-y-4">
          <FormField
            control={form.control}
            name="budgetType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Budget</FormLabel>
                <Select
                  value={field.value || "none"}
                  onValueChange={(value) =>
                    field.onChange(value === "none" ? null : value)
                  }
                >
                  <FormControl>
                    <SelectTrigger className="squircle">
                      <SelectValue placeholder="No budget" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="squircle">
                    <SelectItem value="none">No budget</SelectItem>
                    <SelectItem value="hours">Hours budget</SelectItem>
                    <SelectItem value="fixed">Fixed price</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {form.watch("budgetType") === "hours" && (
            <FormField
              control={form.control}
              name="budgetHours"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Total hours</FormLabel>
                  <FormDescription>
                    Total hours budgeted for this project.
                  </FormDescription>
                  <FormControl>
                    <Input
                      {...field}
                      type="number"
                      min="0"
                      step="0.5"
                      placeholder="100"
                      className="squircle"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {form.watch("budgetType") === "fixed" && (
            <FormField
              control={form.control}
              name="budgetAmount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Budget amount</FormLabel>
                  <FormDescription>
                    Total fixed price for this project.
                  </FormDescription>
                  <FormControl>
                    <CurrencyInput {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>

        {isEditing && project?.isArchived && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
            <p className="text-sm text-amber-800 dark:text-amber-200">
              This project is archived. It won&apos;t appear in time entry
              suggestions.
            </p>
          </div>
        )}
      </form>
    </Form>
  );
}
