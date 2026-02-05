"use client";

import { useState, useEffect } from "react";
import { format, addMonths, addWeeks, addYears } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

type Project = {
  id: string;
  name: string;
  client: {
    id: string;
    name: string;
  };
};

type ExpenseDialogProps = {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
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

export function ExpenseDialog({
  orgId,
  open,
  onOpenChange,
  onSuccess,
}: ExpenseDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

  // Form state
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [category, setCategory] = useState("");
  const [projectId, setProjectId] = useState<string>("none");
  const [isBillable, setIsBillable] = useState(false);
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringFrequency, setRecurringFrequency] = useState("monthly");

  // Fetch projects when dialog opens
  useEffect(() => {
    if (open && projects.length === 0) {
      fetchProjects();
    }
  }, [open]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      setDescription("");
      setAmount("");
      setDate(format(new Date(), "yyyy-MM-dd"));
      setCategory("");
      setProjectId("none");
      setIsBillable(false);
      setIsRecurring(false);
      setRecurringFrequency("monthly");
    }
  }, [open]);

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!description.trim()) {
      toast.error("Description is required");
      return;
    }

    const amountCents = Math.round(parseFloat(amount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      toast.error("Valid amount is required");
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/expenses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          amountCents,
          date,
          category: category || null,
          projectId: projectId === "none" ? null : projectId,
          isBillable,
          isRecurring,
          recurringFrequency: isRecurring ? recurringFrequency : null,
          nextOccurrence: isRecurring ? calculateNextOccurrence(date, recurringFrequency) : null,
        }),
      });

      if (response.ok) {
        toast.success(isRecurring ? "Recurring expense created" : "Expense added");
        onSuccess();
      } else {
        const data = await response.json();
        toast.error(data.error || "Failed to add expense");
      }
    } catch (err) {
      console.error("Error creating expense:", err);
      toast.error("Failed to add expense");
    } finally {
      setIsLoading(false);
    }
  }

  // Group projects by client for the dropdown
  const projectsByClient = projects.reduce((acc, project) => {
    const clientName = project.client.name;
    if (!acc[clientName]) {
      acc[clientName] = [];
    }
    acc[clientName].push(project);
    return acc;
  }, {} as Record<string, Project[]>);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Add Expense</DialogTitle>
          <DialogDescription>
            Track a project expense or general business cost.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g., Figma subscription"
              className="squircle"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="amount">Amount</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  $
                </span>
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="pl-7 squircle"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="date">{isRecurring ? "Start Date" : "Date"}</Label>
              <Input
                id="date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="squircle"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="category">Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="category" className="squircle">
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent className="squircle">
                {DEFAULT_CATEGORIES.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="project">Project (optional)</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="project" className="squircle">
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent className="squircle">
                <SelectItem value="none">
                  <span className="text-muted-foreground">General Business (Overhead)</span>
                </SelectItem>
                {projectsLoading ? (
                  <div className="flex items-center justify-center py-2">
                    <Loader2 className="size-4 animate-spin" />
                  </div>
                ) : (
                  Object.entries(projectsByClient).map(([clientName, clientProjects]) => (
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
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Recurring toggle */}
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <RefreshCw className="size-4 text-muted-foreground" />
              <div className="space-y-0.5">
                <Label htmlFor="recurring">Recurring expense</Label>
                <p className="text-xs text-muted-foreground">
                  Auto-generate on schedule
                </p>
              </div>
            </div>
            <Switch
              id="recurring"
              checked={isRecurring}
              onCheckedChange={setIsRecurring}
            />
          </div>

          {/* Frequency selector - only show when recurring */}
          {isRecurring && (
            <div className="space-y-2">
              <Label htmlFor="frequency">Frequency</Label>
              <Select value={recurringFrequency} onValueChange={setRecurringFrequency}>
                <SelectTrigger id="frequency" className="squircle">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="squircle">
                  {RECURRING_FREQUENCIES.map((freq) => (
                    <SelectItem key={freq.value} value={freq.value}>
                      {freq.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Billable toggle */}
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="billable">Billable to client</Label>
              <p className="text-xs text-muted-foreground">
                Include on client invoices
              </p>
            </div>
            <Switch
              id="billable"
              checked={isBillable}
              onCheckedChange={setIsBillable}
              disabled={projectId === "none"}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="squircle"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading} className="squircle">
              {isLoading && <Loader2 className="size-4 animate-spin" />}
              {isRecurring ? "Create Recurring" : "Add Expense"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
