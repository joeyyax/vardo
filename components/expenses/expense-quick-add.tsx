"use client";

import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { Plus, Loader2, CalendarIcon, RefreshCw } from "lucide-react";
import { format } from "date-fns";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { DEFAULT_CATEGORIES, parseCurrency } from "./utils";

type Project = {
  id: string;
  name: string;
  client: {
    id: string;
    name: string;
  };
};

type ExpenseQuickAddProps = {
  orgId: string;
  onExpenseCreated: () => void;
};

export function ExpenseQuickAdd({ orgId, onExpenseCreated }: ExpenseQuickAddProps) {
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("none");
  const [projectId, setProjectId] = useState("none");
  const [date, setDate] = useState<Date>(new Date());
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringFrequency, setRecurringFrequency] = useState("monthly");
  const [backfillRecurring, setBackfillRecurring] = useState(false);
  const [backfillEndDate, setBackfillEndDate] = useState<Date>(new Date());
  const [backfillEndDatePickerOpen, setBackfillEndDatePickerOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);

  const descriptionRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  // Fetch projects on first focus
  useEffect(() => {
    if (isFocused && !projectsLoaded) {
      fetchProjects();
    }
  }, [isFocused, projectsLoaded]);

  async function fetchProjects() {
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/projects`);
      if (response.ok) {
        const data = await response.json();
        setProjects(data.projects || data);
      }
    } catch (err) {
      console.error("Error fetching projects:", err);
    } finally {
      setProjectsLoaded(true);
    }
  }

  // Format date as YYYY-MM-DD
  function formatDateForApi(d: Date): string {
    return format(d, "yyyy-MM-dd");
  }

  async function handleSubmit() {
    const desc = description.trim();
    const amountCents = parseCurrency(amount);

    if (!desc) {
      toast.error("Description is required");
      descriptionRef.current?.focus();
      return;
    }

    if (!amountCents || amountCents <= 0) {
      toast.error("Valid amount is required");
      amountRef.current?.focus();
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/expenses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: desc,
          amountCents,
          date: formatDateForApi(date),
          category: category === "none" ? null : category,
          projectId: projectId === "none" ? null : projectId,
          isBillable: false,
          isRecurring,
          recurringFrequency: isRecurring ? recurringFrequency : null,
          backfillRecurring: isRecurring && backfillRecurring,
          backfillEndDate: isRecurring && backfillRecurring ? formatDateForApi(backfillEndDate) : null,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const count = data.created || 1;
        toast.success(count > 1 ? `${count} expenses added` : "Expense added");
        // Reset form
        setDescription("");
        setAmount("");
        setCategory("none");
        setProjectId("none");
        setDate(new Date());
        setIsRecurring(false);
        setBackfillRecurring(false);
        setBackfillEndDate(new Date());
        // Notify parent
        onExpenseCreated();
        // Keep focus on description for next entry
        descriptionRef.current?.focus();
      } else {
        const data = await response.json();
        toast.error(data.error || "Failed to add expense");
      }
    } catch (err) {
      console.error("Error creating expense:", err);
      toast.error("Failed to add expense");
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    // Tab from description to amount
    if (e.key === "Tab" && !e.shiftKey && e.currentTarget === descriptionRef.current) {
      e.preventDefault();
      amountRef.current?.focus();
      amountRef.current?.select();
    }
  }

  // Group projects by client
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

  // Check if date is in the past
  const isDateInPast = date < new Date(new Date().setHours(0, 0, 0, 0));
  const isToday = format(date, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");

  return (
    <div className="space-y-3">
      <div
        className="flex items-center gap-3 p-3 border rounded-lg bg-card"
        onFocus={() => setIsFocused(true)}
      >
        {/* Description input */}
        <div className="flex-1">
          <Input
            ref={descriptionRef}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What was this expense for?"
            className="border-0 bg-transparent focus-visible:ring-0 px-0 h-9 text-sm"
            disabled={isSubmitting}
          />
        </div>

        {/* Amount input */}
        <div className="w-24">
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
              $
            </span>
            <Input
              ref={amountRef}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="0.00"
              className="border-0 bg-transparent focus-visible:ring-0 pl-5 h-9 text-sm text-right"
              disabled={isSubmitting}
            />
          </div>
        </div>

        {/* Category selector */}
        <Select value={category} onValueChange={setCategory} disabled={isSubmitting}>
          <SelectTrigger className="w-[120px] h-9 border-0 bg-muted/50 text-sm squircle">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent className="squircle">
            <SelectItem value="none">
              <span className="text-muted-foreground">No category</span>
            </SelectItem>
            {DEFAULT_CATEGORIES.map((cat) => (
              <SelectItem key={cat} value={cat}>
                {cat}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Project selector */}
        <Select value={projectId} onValueChange={setProjectId} disabled={isSubmitting}>
          <SelectTrigger className="w-[140px] h-9 border-0 bg-muted/50 text-sm squircle">
            <SelectValue placeholder="Project" />
          </SelectTrigger>
          <SelectContent className="squircle">
            <SelectItem value="none">
              <span className="text-muted-foreground">Overhead</span>
            </SelectItem>
            {Object.entries(projectsByClient).map(([clientName, clientProjects]) => (
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
            ))}
          </SelectContent>
        </Select>

        {/* Date picker */}
        <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className={cn(
                "h-9 border-0 bg-muted/50 text-sm squircle justify-start",
                !isToday && "text-blue-600 dark:text-blue-400"
              )}
              disabled={isSubmitting}
            >
              <CalendarIcon className="size-4 mr-1" />
              {isToday ? "Today" : format(date, "MMM d")}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={date}
              onSelect={(newDate) => {
                if (newDate) {
                  setDate(newDate);
                  setDatePickerOpen(false);
                }
              }}
              initialFocus
            />
          </PopoverContent>
        </Popover>

        {/* Recurring toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className={cn(
                "h-9 w-9 border-0 bg-muted/50 squircle",
                isRecurring && "text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/30"
              )}
              onClick={() => {
                setIsRecurring(!isRecurring);
                if (!isRecurring) {
                  // When turning on recurring, auto-enable backfill if date is in past
                  setBackfillRecurring(isDateInPast);
                }
              }}
              disabled={isSubmitting}
            >
              <RefreshCw className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {isRecurring ? "Recurring expense" : "Make recurring"}
          </TooltipContent>
        </Tooltip>

        {/* Submit button */}
        <Button
          onClick={handleSubmit}
          disabled={isSubmitting || !description.trim() || !amount}
          size="sm"
          className="squircle"
        >
          {isSubmitting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          Add
        </Button>
      </div>

      {/* Recurring options row */}
      {isRecurring && (
        <div className="flex items-center gap-3 px-3 text-sm">
          <span className="text-muted-foreground">Repeats</span>
          <Select value={recurringFrequency} onValueChange={setRecurringFrequency}>
            <SelectTrigger className="w-[120px] h-8 text-sm squircle">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="squircle">
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="quarterly">Quarterly</SelectItem>
              <SelectItem value="yearly">Yearly</SelectItem>
            </SelectContent>
          </Select>

          {isDateInPast && (
            <>
              <div className="h-4 w-px bg-border" />
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={backfillRecurring}
                  onChange={(e) => setBackfillRecurring(e.target.checked)}
                  className="rounded"
                />
                <span className="text-muted-foreground">
                  Backfill to
                </span>
              </label>
              {backfillRecurring && (
                <Popover open={backfillEndDatePickerOpen} onOpenChange={setBackfillEndDatePickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs squircle"
                    >
                      <CalendarIcon className="size-3 mr-1" />
                      {format(backfillEndDate, "MMM d, yyyy")}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={backfillEndDate}
                      onSelect={(newDate) => {
                        if (newDate) {
                          setBackfillEndDate(newDate);
                          setBackfillEndDatePickerOpen(false);
                        }
                      }}
                      disabled={(d) => d < date} // Can't end before start
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
