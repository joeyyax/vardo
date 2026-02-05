"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Receipt, Loader2, Search, X, Plus, CalendarIcon, ArrowUpDown, ChevronLeft, ChevronRight, DollarSign, Paperclip, MoreVertical, Copy, Trash2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { format, parseISO } from "date-fns";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import type { DateRange as RDPDateRange } from "react-day-picker";
import type { Expense, DateRange } from "./types";
import {
  getDateRangeFromPreset,
  getCustomDateRange,
  getMonthRange,
  shiftDateRange,
  groupExpensesByDate,
  getTodayDate,
  formatCurrency,
  DATE_RANGE_PRESETS,
} from "./utils";
import { ExpenseDayGroup } from "./expense-day-group";
import { ExpenseDetailModal } from "./expense-detail-modal";
import { ExpenseDialog } from "./expense-dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { eventBus } from "@/lib/events";
import { ViewSwitcher } from "@/components/view-switcher";
import { useViewPreference } from "@/hooks/use-view-preference";
import { PageToolbar } from "@/components/page-toolbar";

type ExpenseTimelineProps = {
  orgId: string;
  currentUserId: string;
  initialDate?: string;
  highlightExpenseId?: string;
};

const EXPENSE_VIEWS = ["timeline", "table"] as const;

// Snappy spring for layout reflow — quick with a touch of momentum
const layoutTransition = { type: "spring" as const, duration: 0.25, bounce: 0.1 };

// Read initial filter state from URL search params
function getInitialFilters() {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  return {
    preset: params.get("preset") || undefined,
    from: params.get("from") || undefined,
    to: params.get("to") || undefined,
    search: params.get("q") || undefined,
    category: params.get("category") || undefined,
    billable: params.get("billable") || undefined,
    sortBy: params.get("sort") || undefined,
    sortOrder: params.get("order") || undefined,
    expense: params.get("expense") || undefined,
  };
}

export function ExpenseTimeline({
  orgId,
  currentUserId,
  initialDate,
  highlightExpenseId,
}: ExpenseTimelineProps) {
  const initialFilters = useRef(getInitialFilters());
  const [view, setView] = useViewPreference("expenses", EXPENSE_VIEWS, "timeline");

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>(() => {
    const f = initialFilters.current;
    // Range with explicit dates from URL
    if (f.from && f.to) {
      const preset = f.preset || "custom";
      if (preset === "custom" || preset === "last-30" || preset === "last-90") {
        return getCustomDateRange(f.from, f.to);
      }
      // Reconstruct label for shifted preset ranges
      const start = parseISO(f.from);
      let label = "";
      if (preset === "month" || preset === "this-month" || preset === "last-month") {
        label = format(start, "MMMM yyyy");
      } else if (preset === "quarter" || preset === "this-quarter" || preset === "last-quarter") {
        label = `Q${Math.ceil((start.getMonth() + 1) / 3)} ${format(start, "yyyy")}`;
      } else if (preset === "year" || preset === "this-year") {
        label = format(start, "yyyy");
      } else {
        return getCustomDateRange(f.from, f.to);
      }
      return { from: f.from, to: f.to, label, preset };
    }
    // Preset without explicit dates from URL
    if (f.preset && f.preset !== "custom") {
      return getDateRangeFromPreset(f.preset);
    }
    // Legacy initialDate prop
    if (initialDate) {
      return getMonthRange(new Date(initialDate + "T12:00:00"));
    }
    return getDateRangeFromPreset("this-month");
  });
  const [customRange, setCustomRange] = useState<RDPDateRange | undefined>();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | undefined>(
    highlightExpenseId || initialFilters.current.expense
  );
  const [detailExpense, setDetailExpense] = useState<Expense | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  // Search, filter & sort state
  const [searchQuery, setSearchQuery] = useState(initialFilters.current.search || "");
  const [categoryFilter, setCategoryFilter] = useState<string>(initialFilters.current.category || "all");
  const [billableFilter, setBillableFilter] = useState<string>(initialFilters.current.billable || "all");
  const [sortBy, setSortBy] = useState<"date" | "amount" | "description">(
    (initialFilters.current.sortBy as "date" | "amount" | "description") || "date"
  );
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">(
    (initialFilters.current.sortOrder as "asc" | "desc") || "desc"
  );

  // Sync filter state to URL
  useEffect(() => {
    const params = new URLSearchParams();

    // Date range — always include from/to so the URL is shareable
    params.set("from", dateRange.from);
    params.set("to", dateRange.to);
    if (dateRange.preset && dateRange.preset !== "this-month") {
      params.set("preset", dateRange.preset);
    }

    if (searchQuery.trim()) params.set("q", searchQuery.trim());
    if (categoryFilter !== "all") params.set("category", categoryFilter);
    if (billableFilter !== "all") params.set("billable", billableFilter);
    if (sortBy !== "date") params.set("sort", sortBy);
    if (sortOrder !== "desc") params.set("order", sortOrder);

    const qs = params.toString();
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", newUrl);
  }, [dateRange, searchQuery, categoryFilter, billableFilter, sortBy, sortOrder]);

  // Fetch expenses for the date range
  const fetchExpenses = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        startDate: dateRange.from,
        endDate: dateRange.to,
      });

      const res = await fetch(
        `/api/v1/organizations/${orgId}/expenses?${params}`
      );

      if (!res.ok) {
        throw new Error("Failed to fetch expenses");
      }

      const data = await res.json();
      setExpenses(data.expenses);
    } catch (err) {
      console.error("Error fetching expenses:", err);
      setError("Failed to load expenses. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [orgId, dateRange]);

  // Fetch on mount and when date range changes
  useEffect(() => {
    fetchExpenses();
  }, [fetchExpenses]);

  // Subscribe to event bus for real-time updates
  useEffect(() => {
    const unsubs = [
      eventBus.on("expense:updated", () => fetchExpenses()),
      eventBus.on("expense:deleted", () => fetchExpenses()),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, [fetchExpenses]);

  // Date range handlers
  const handlePresetChange = (preset: string) => {
    if (preset === "custom") {
      setCustomRange({
        from: parseISO(dateRange.from),
        to: parseISO(dateRange.to),
      });
      setDateRange({ ...dateRange, preset: "custom" });
      setCalendarOpen(true);
    } else {
      setDateRange(getDateRangeFromPreset(preset));
    }
  };

  const handleCustomRangeSelect = (range: RDPDateRange | undefined) => {
    setCustomRange(range);
    if (range?.from && range?.to) {
      setDateRange(
        getCustomDateRange(
          format(range.from, "yyyy-MM-dd"),
          format(range.to, "yyyy-MM-dd")
        )
      );
    }
  };

  function formatCustomRangeLabel(range: RDPDateRange | undefined): string {
    if (!range?.from) return "Select dates";
    if (!range.to) return format(range.from, "MMM d, yyyy");
    const sameYear = range.from.getFullYear() === range.to.getFullYear();
    return sameYear
      ? `${format(range.from, "MMM d")} – ${format(range.to, "MMM d, yyyy")}`
      : `${format(range.from, "MMM d, yyyy")} – ${format(range.to, "MMM d, yyyy")}`;
  }

  // Expense mutation handlers
  const deleteExpense = async (expenseId: string) => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/expenses/${expenseId}`,
        { method: "DELETE" }
      );

      if (!res.ok) {
        throw new Error("Failed to delete expense");
      }

      setExpenses((prev) => prev.filter((e) => e.id !== expenseId));
      eventBus.emit("expense:deleted", { expenseId });
      toast.success("Expense deleted");
    } catch (err) {
      console.error("Error deleting expense:", err);
      toast.error("Failed to delete expense");
      fetchExpenses();
    }
  };

  const duplicateExpense = async (expense: Expense) => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/expenses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: expense.description,
          amountCents: expense.amountCents,
          date: getTodayDate(),
          category: expense.category,
          projectId: expense.project?.id || null,
          isBillable: expense.isBillable,
          isRecurring: false,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to duplicate expense");
      }

      toast.success("Expense duplicated");
      fetchExpenses();
    } catch (err) {
      console.error("Error duplicating expense:", err);
      toast.error("Failed to duplicate expense");
    }
  };

  const handleExpenseClick = useCallback((expense: Expense) => {
    setDetailExpense(expense);
    setDetailModalOpen(true);
  }, []);

  const handleDetailModalClose = useCallback((open: boolean) => {
    setDetailModalOpen(open);
    if (!open) {
      setDetailExpense(null);
    }
  }, []);

  const handleDetailModalUpdate = useCallback(() => {
    fetchExpenses();
  }, [fetchExpenses]);

  // Extract unique categories from current expenses for the filter dropdown
  const availableCategories = useMemo(() => {
    const cats = new Set<string>();
    expenses.forEach((e) => {
      if (e.category) cats.add(e.category);
    });
    return Array.from(cats).sort();
  }, [expenses]);

  // Filter expenses client-side
  const filteredExpenses = useMemo(() => {
    let result = expenses;

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (e) =>
          e.description.toLowerCase().includes(query) ||
          e.vendor?.toLowerCase().includes(query) ||
          e.project?.name.toLowerCase().includes(query) ||
          e.project?.client.name.toLowerCase().includes(query)
      );
    }

    if (categoryFilter !== "all") {
      if (categoryFilter === "uncategorized") {
        result = result.filter((e) => !e.category);
      } else {
        result = result.filter((e) => e.category === categoryFilter);
      }
    }

    if (billableFilter !== "all") {
      const isBillable = billableFilter === "billable";
      result = result.filter((e) => e.isBillable === isBillable);
    }

    // Sort
    result = [...result].sort((a, b) => {
      let comparison = 0;
      switch (sortBy) {
        case "date":
          comparison = a.date.localeCompare(b.date);
          break;
        case "amount":
          comparison = a.amountCents - b.amountCents;
          break;
        case "description":
          comparison = a.description.localeCompare(b.description);
          break;
      }
      return sortOrder === "desc" ? -comparison : comparison;
    });

    return result;
  }, [expenses, searchQuery, categoryFilter, billableFilter, sortBy, sortOrder]);

  // Compute summary from filtered expenses so stats match what's visible
  const summary = useMemo(() => {
    const totalCents = filteredExpenses.reduce(
      (sum, e) => sum + e.amountCents,
      0
    );
    const billableCents = filteredExpenses
      .filter((e) => e.isBillable)
      .reduce((sum, e) => sum + e.amountCents, 0);
    const overheadCents = filteredExpenses
      .filter((e) => !e.project)
      .reduce((sum, e) => sum + e.amountCents, 0);

    return {
      count: filteredExpenses.length,
      totalCents,
      billableCents,
      overheadCents,
    };
  }, [filteredExpenses]);

  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    categoryFilter !== "all" ||
    billableFilter !== "all" ||
    sortBy !== "date" ||
    sortOrder !== "desc";

  const clearFilters = () => {
    setSearchQuery("");
    setCategoryFilter("all");
    setBillableFilter("all");
    setSortBy("date");
    setSortOrder("desc");
  };

  // Group filtered expenses by date
  const dayGroups = groupExpensesByDate(filteredExpenses);

  if (loading && expenses.length === 0) {
    return (
      <div className="space-y-6">
        <div className="h-10 bg-muted/50 rounded animate-pulse" />
        <div className="h-14 bg-muted/30 rounded animate-pulse" />
        <div className="h-px bg-border" />
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <div className="h-5 w-32 bg-muted/50 rounded animate-pulse" />
              <div className="h-10 bg-muted/30 rounded animate-pulse" />
              <div className="h-10 bg-muted/30 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          onClick={fetchExpenses}
          className="mt-2 text-sm text-destructive underline hover:no-underline"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Toolbar: search + filters + date range + add button */}
        <div className="flex flex-col gap-3">
          <PageToolbar
            actions={
              <>
                <ViewSwitcher views={EXPENSE_VIEWS} value={view} onValueChange={setView} />
                <Button
                  onClick={() => setCreateDialogOpen(true)}
                  className="squircle shrink-0"
                >
                  <Plus className="size-4" />
                  Add expense
                </Button>
              </>
            }
          >
            <motion.div layout transition={layoutTransition} className="relative flex-1 max-w-xs min-w-[180px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                placeholder="Search expenses..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 squircle bg-background"
              />
            </motion.div>

            <motion.div layout transition={layoutTransition}>
              <Select
                value={dateRange.preset}
                onValueChange={handlePresetChange}
              >
                <SelectTrigger className="w-auto min-w-[160px] squircle bg-background">
                  <CalendarIcon className="size-4 text-muted-foreground mr-2 shrink-0" />
                  <span className="truncate">{dateRange.label}</span>
                </SelectTrigger>
                <SelectContent className="squircle">
                  {DATE_RANGE_PRESETS.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </motion.div>

            <AnimatePresence>
              {dateRange.preset === "custom" && (
                <motion.div
                  layout
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={layoutTransition}
                >
                  <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className="squircle min-w-[240px] bg-background"
                      >
                        <CalendarIcon className="size-4" />
                        {formatCustomRangeLabel(customRange)}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      className="squircle w-auto p-0"
                      align="start"
                    >
                      <Calendar
                        mode="range"
                        selected={customRange}
                        onSelect={handleCustomRangeSelect}
                        numberOfMonths={2}
                      />
                    </PopoverContent>
                  </Popover>
                </motion.div>
              )}
            </AnimatePresence>

            <motion.div layout transition={layoutTransition}>
              <Select
                value={categoryFilter}
                onValueChange={setCategoryFilter}
              >
                <SelectTrigger className="w-[150px] squircle bg-background">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent className="squircle">
                  <SelectItem value="all">All categories</SelectItem>
                  <SelectItem value="uncategorized">Uncategorized</SelectItem>
                  {availableCategories.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </motion.div>

            <motion.div layout transition={layoutTransition}>
              <Select
                value={billableFilter}
                onValueChange={setBillableFilter}
              >
                <SelectTrigger className="w-[130px] squircle bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="squircle">
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="billable">Billable</SelectItem>
                  <SelectItem value="non-billable">Non-billable</SelectItem>
                </SelectContent>
              </Select>
            </motion.div>

            <motion.div layout transition={layoutTransition}>
              <Select
                value={sortBy}
                onValueChange={(v) => setSortBy(v as "date" | "amount" | "description")}
              >
                <SelectTrigger className="w-[120px] squircle bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="squircle">
                  <SelectItem value="date">Date</SelectItem>
                  <SelectItem value="amount">Amount</SelectItem>
                  <SelectItem value="description">Name</SelectItem>
                </SelectContent>
              </Select>
            </motion.div>

            <motion.div layout transition={layoutTransition}>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
                title={sortOrder === "asc" ? "Ascending" : "Descending"}
                className="squircle shrink-0 bg-background"
              >
                <ArrowUpDown className={`size-4 transition-transform ${sortOrder === "asc" ? "rotate-180" : ""}`} />
              </Button>
            </motion.div>

            <AnimatePresence>
              {hasActiveFilters && (
                <motion.div
                  layout
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={layoutTransition}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={clearFilters}
                    title="Clear filters"
                    className="shrink-0"
                  >
                    <X className="size-4" />
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </PageToolbar>

          {/* Summary stats */}
          <div className="flex items-center gap-6 text-sm">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDateRange(shiftDateRange(dateRange, -1))}
                className="size-6"
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              <span className="font-medium">{dateRange.label}</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDateRange(shiftDateRange(dateRange, 1))}
                className="size-6"
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
            <AnimatePresence>
              {summary.count > 0 && (
                <motion.div
                  className="flex items-center gap-6"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  transition={layoutTransition}
                >
                  <div className="w-px h-4 bg-border" />
                  <div className="text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {summary.count}
                    </span>{" "}
                    {summary.count === 1 ? "expense" : "expenses"}
                  </div>
                  {summary.overheadCents > 0 && (
                    <div className="text-amber-600 dark:text-amber-400">
                      <span className="font-medium">
                        {formatCurrency(summary.overheadCents)}
                      </span>{" "}
                      overhead
                    </div>
                  )}
                  {summary.billableCents > 0 && (
                    <div className="text-green-600 dark:text-green-400">
                      <span className="font-medium">
                        {formatCurrency(summary.billableCents)}
                      </span>{" "}
                      billable
                    </div>
                  )}
                  <div className="font-semibold">
                    {formatCurrency(summary.totalCents)} total
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="h-px bg-border" />

        {/* Expense content — empty state, table view, or timeline view */}
        {filteredExpenses.length === 0 ? (
          <Card className="squircle">
            <CardContent className="py-12 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
                {hasActiveFilters ? (
                  <Search className="size-6 text-muted-foreground" />
                ) : (
                  <Receipt className="size-6 text-muted-foreground" />
                )}
              </div>
              <h3 className="mt-4 text-lg font-medium">
                {hasActiveFilters
                  ? "No matching expenses"
                  : "No expenses in this period"}
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {hasActiveFilters ? (
                  <button
                    onClick={clearFilters}
                    className="text-primary underline hover:no-underline"
                  >
                    Clear filters
                  </button>
                ) : (
                  "Use the button above to add an expense."
                )}
              </p>
            </CardContent>
          </Card>
        ) : view === "table" ? (
          <div className="rounded-lg border squircle overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Billable</TableHead>
                  <TableHead>Receipt</TableHead>
                  <TableHead className="w-[50px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredExpenses.map((expense) => {
                  const isOverhead = !expense.project;

                  return (
                    <TableRow
                      key={expense.id}
                      className="cursor-pointer"
                      onClick={() => handleExpenseClick(expense)}
                    >
                      <TableCell className="text-muted-foreground">
                        {format(parseISO(expense.date), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell className="font-medium max-w-[250px] truncate">
                        {expense.description}
                      </TableCell>
                      <TableCell>
                        {expense.category ? (
                          <span className="bg-muted/60 text-xs px-2 py-0.5 rounded">
                            {expense.category}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50 text-xs">--</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isOverhead ? (
                          <span className="text-xs text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 rounded">
                            Overhead
                          </span>
                        ) : (
                          <span className="text-sm">{expense.project?.name}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {expense.project ? (
                          <div className="flex items-center gap-2">
                            <div
                              className="size-2 rounded-full shrink-0"
                              style={{ backgroundColor: expense.project.client.color || "#94a3b8" }}
                            />
                            <span className="text-sm">{expense.project.client.name}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground/50 text-xs">--</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {expense.vendor || <span className="text-muted-foreground/50 text-xs">--</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={cn(
                            "font-medium tabular-nums",
                            expense.isBillable && "text-green-600 dark:text-green-400"
                          )}
                        >
                          {formatCurrency(expense.amountCents)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <DollarSign
                          className={cn(
                            "size-4",
                            expense.isBillable
                              ? "text-green-600 dark:text-green-400"
                              : "text-muted-foreground/30"
                          )}
                        />
                      </TableCell>
                      <TableCell>
                        {expense.receiptFile && (
                          <Paperclip className="size-4 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                            <Button variant="ghost" size="icon" className="size-8 shrink-0">
                              <MoreVertical className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="squircle">
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                duplicateExpense(expense);
                              }}
                            >
                              <Copy className="size-4" />
                              Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteExpense(expense.id);
                              }}
                            >
                              <Trash2 className="size-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="space-y-8">
            {dayGroups.map((group) => (
              <ExpenseDayGroup
                key={group.date}
                date={group.date}
                expenses={group.expenses}
                totalCents={group.totalCents}
                orgId={orgId}
                currentUserId={currentUserId}
                onDeleteExpense={deleteExpense}
                onDuplicateExpense={duplicateExpense}
                onExpenseClick={handleExpenseClick}
                highlightedExpenseId={highlightedId}
                onClearHighlight={() => setHighlightedId(undefined)}
              />
            ))}
          </div>
        )}

        {/* Loading indicator when refetching */}
        {loading && expenses.length > 0 && (
          <div className="fixed bottom-4 right-4 bg-background border rounded-lg px-3 py-2 shadow-lg">
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="size-3 animate-spin" />
              Loading...
            </p>
          </div>
        )}

        <ExpenseDetailModal
          orgId={orgId}
          currentUserId={currentUserId}
          expense={detailExpense}
          open={detailModalOpen}
          onOpenChange={handleDetailModalClose}
          onUpdate={handleDetailModalUpdate}
        />

        <ExpenseDialog
          orgId={orgId}
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          onCreated={fetchExpenses}
        />
      </div>
    </TooltipProvider>
  );
}
