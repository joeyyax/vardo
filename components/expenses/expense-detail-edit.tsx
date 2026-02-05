"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { format, addMonths, addWeeks, addYears } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { expenseSchema, type ExpenseFormData } from "@/lib/schemas/expense";
import type { Expense } from "./types";

type Project = {
  id: string;
  name: string;
  client: {
    id: string;
    name: string;
  };
};

type ExpenseDetailEditProps = {
  orgId: string;
  expense: Expense;
  onSave: () => void;
  onCancel: () => void;
};

const DEFAULT_CATEGORIES = [
  "Software",
  "Hosting",
  "Contractor",
  "Travel",
  "Supplies",
  "Equipment",
  "Marketing",
  "Insurance",
  "Subscriptions",
  "Other",
];

const RECURRING_FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

function calculateNextOccurrence(date: string, frequency: string): string {
  const d = new Date(date);
  switch (frequency) {
    case "weekly":
      return format(addWeeks(d, 1), "yyyy-MM-dd");
    case "monthly":
      return format(addMonths(d, 1), "yyyy-MM-dd");
    case "quarterly":
      return format(addMonths(d, 3), "yyyy-MM-dd");
    case "yearly":
      return format(addYears(d, 1), "yyyy-MM-dd");
    default:
      return format(addMonths(d, 1), "yyyy-MM-dd");
  }
}

export function ExpenseDetailEdit({
  orgId,
  expense,
  onSave,
  onCancel,
}: ExpenseDetailEditProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [vendors, setVendors] = useState<string[]>([]);

  const form = useForm<ExpenseFormData>({
    resolver: zodResolver(expenseSchema),
    defaultValues: {
      description: expense.description,
      amount: (expense.amountCents / 100).toString(),
      date: expense.date,
      category: expense.category || "",
      projectId: expense.project?.id || "none",
      isBillable: expense.isBillable,
      isRecurring: expense.isRecurring,
      recurringFrequency: expense.recurringFrequency || "monthly",
      vendor: expense.vendor || "",
      status: (expense.status as "paid" | "unpaid") || "paid",
    },
  });

  const isRecurring = form.watch("isRecurring");
  const projectId = form.watch("projectId");

  // Fetch projects and vendors on mount
  useEffect(() => {
    fetchProjects();
    fetchVendors();
  }, []);

  async function fetchVendors() {
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/expenses`);
      if (response.ok) {
        const data = await response.json();
        setVendors(data.vendors || []);
      }
    } catch (err) {
      console.error("Error fetching vendors:", err);
    }
  }

  async function fetchProjects() {
    setProjectsLoading(true);
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/projects`);
      if (response.ok) {
        const data = await response.json();
        setProjects(data.projects || data);
      }
    } catch (err) {
      console.error("Error fetching projects:", err);
    } finally {
      setProjectsLoading(false);
    }
  }

  async function onSubmit(data: ExpenseFormData) {
    const amountCents = Math.round(parseFloat(data.amount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      toast.error("Valid amount is required");
      return;
    }

    setIsLoading(true);
    try {
      const payload = {
        description: data.description.trim(),
        amountCents,
        date: data.date,
        category: data.category || null,
        projectId: data.projectId === "none" ? null : data.projectId,
        isBillable: data.isBillable,
        isRecurring: data.isRecurring,
        recurringFrequency: data.isRecurring ? data.recurringFrequency : null,
        nextOccurrence: data.isRecurring
          ? calculateNextOccurrence(data.date, data.recurringFrequency)
          : null,
        vendor: data.vendor || null,
        status: data.status || "paid",
      };

      const response = await fetch(
        `/api/v1/organizations/${orgId}/expenses/${expense.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      if (response.ok) {
        toast.success("Expense updated");
        onSave();
      } else {
        const responseData = await response.json();
        toast.error(responseData.error || "Failed to update expense");
      }
    } catch (err) {
      console.error("Error updating expense:", err);
      toast.error("Failed to update expense");
    } finally {
      setIsLoading(false);
    }
  }

  // Group projects by client for the dropdown
  const projectsByClient = projects.reduce(
    (acc, project) => {
      const clientName = project.client.name;
      if (!acc[clientName]) {
        acc[clientName] = [];
      }
      acc[clientName].push(project);
      return acc;
    },
    {} as Record<string, Project[]>
  );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  placeholder="e.g., Figma subscription"
                  className="squircle"
                  autoFocus
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="amount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Amount</FormLabel>
                <FormControl>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                      $
                    </span>
                    <Input
                      {...field}
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      className="pl-7 squircle"
                    />
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{isRecurring ? "Start Date" : "Date"}</FormLabel>
                <FormControl>
                  <Input {...field} type="date" className="squircle" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="category"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Category</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="squircle">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className="squircle">
                  {DEFAULT_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
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
          name="vendor"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Vendor</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  placeholder="e.g., Adobe, AWS"
                  className="squircle"
                  list="vendor-suggestions-edit"
                />
              </FormControl>
              <datalist id="vendor-suggestions-edit">
                {vendors.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="status"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Payment Status</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="squircle">
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className="squircle">
                  <SelectItem value="paid">Paid</SelectItem>
                  <SelectItem value="unpaid">Unpaid</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="projectId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Project (optional)</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="squircle">
                    <SelectValue placeholder="Select project" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className="squircle">
                  <SelectItem value="none">
                    <span className="text-muted-foreground">
                      General Business (Overhead)
                    </span>
                  </SelectItem>
                  {projectsLoading ? (
                    <div className="flex items-center justify-center py-2">
                      <Loader2 className="size-4 animate-spin" />
                    </div>
                  ) : (
                    Object.entries(projectsByClient).map(
                      ([clientName, clientProjects]) => (
                        <div key={clientName}>
                          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                            {clientName}
                          </div>
                          {clientProjects.map((project) => (
                            <SelectItem key={project.id} value={project.id}>
                              {project.name}
                            </SelectItem>
                          ))}
                        </div>
                      )
                    )
                  )}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Recurring toggle */}
        <FormField
          control={form.control}
          name="isRecurring"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <RefreshCw className="size-4 text-muted-foreground" />
                <div className="space-y-0.5">
                  <FormLabel>Recurring expense</FormLabel>
                  <FormDescription>Auto-generate on schedule</FormDescription>
                </div>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />

        {/* Frequency selector - only show when recurring */}
        {isRecurring && (
          <FormField
            control={form.control}
            name="recurringFrequency"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Frequency</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="squircle">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="squircle">
                    {RECURRING_FREQUENCIES.map((freq) => (
                      <SelectItem key={freq.value} value={freq.value}>
                        {freq.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {/* Billable toggle */}
        <FormField
          control={form.control}
          name="isBillable"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <FormLabel>Billable to client</FormLabel>
                <FormDescription>Include on client invoices</FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={projectId === "none"}
                />
              </FormControl>
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2 pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            className="squircle"
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isLoading} className="squircle">
            {isLoading && <Loader2 className="size-4 animate-spin" />}
            Save Changes
          </Button>
        </div>
      </form>
    </Form>
  );
}
