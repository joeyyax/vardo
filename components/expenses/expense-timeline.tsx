"use client";

import { useState, useEffect, useCallback } from "react";
import { Receipt, Loader2 } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Card, CardContent } from "@/components/ui/card";
import type { Expense, MonthRange, ExpenseSummary } from "./types";
import {
  getMonthRange,
  getPreviousMonth,
  getNextMonth,
  isCurrentMonth,
  groupExpensesByDate,
  getTodayDate,
} from "./utils";
import { ExpenseMonthHeader } from "./expense-month-header";
import { ExpenseQuickAdd } from "./expense-quick-add";
import { ExpenseDayGroup } from "./expense-day-group";
import { ExpenseDetailModal } from "./expense-detail-modal";
import { toast } from "sonner";

type ExpenseTimelineProps = {
  orgId: string;
  currentUserId: string;
  initialDate?: string;
  highlightExpenseId?: string;
};

export function ExpenseTimeline({
  orgId,
  currentUserId,
  initialDate,
  highlightExpenseId,
}: ExpenseTimelineProps) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [summary, setSummary] = useState<ExpenseSummary | null>(null);
  const [monthRange, setMonthRange] = useState<MonthRange>(() =>
    getMonthRange(initialDate ? new Date(initialDate + "T12:00:00") : new Date())
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | undefined>(
    highlightExpenseId
  );
  const [detailExpense, setDetailExpense] = useState<Expense | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);

  const isCurrentMonthView = isCurrentMonth(monthRange);

  // Fetch expenses for the current month
  const fetchExpenses = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        startDate: monthRange.from,
        endDate: monthRange.to,
      });

      const res = await fetch(
        `/api/v1/organizations/${orgId}/expenses?${params}`
      );

      if (!res.ok) {
        throw new Error("Failed to fetch expenses");
      }

      const data = await res.json();
      setExpenses(data.expenses);
      setSummary(data.summary);
    } catch (err) {
      console.error("Error fetching expenses:", err);
      setError("Failed to load expenses. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [orgId, monthRange]);

  // Fetch on mount and when month changes
  useEffect(() => {
    fetchExpenses();
  }, [fetchExpenses]);

  // Navigation handlers
  const goToPreviousMonth = () => {
    setMonthRange(getPreviousMonth(monthRange));
  };

  const goToNextMonth = () => {
    setMonthRange(getNextMonth(monthRange));
  };

  const goToThisMonth = () => {
    setMonthRange(getMonthRange(new Date()));
  };

  // Expense mutation handlers
  const updateExpense = async (
    expenseId: string,
    updates: Partial<{
      description: string;
      amountCents: number;
      category: string | null;
      isBillable: boolean;
      projectId: string | null;
      date: string;
    }>
  ) => {
    // If date is changing, we need to refetch to move the expense to the correct day group
    const needsRefetch = "date" in updates;

    // Optimistically update local state with just the changed fields
    if (!needsRefetch) {
      setExpenses((prev) =>
        prev.map((e) => (e.id === expenseId ? { ...e, ...updates } : e))
      );
    }

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/expenses/${expenseId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        }
      );

      if (!res.ok) {
        throw new Error("Failed to update expense");
      }

      // Refetch if date changed to update grouping
      if (needsRefetch) {
        fetchExpenses();
      }
    } catch (err) {
      console.error("Error updating expense:", err);
      toast.error("Failed to update expense");
      // Refetch to revert optimistic update
      fetchExpenses();
    }
  };

  // Project change requires refetch to get new project/client data
  const changeExpenseProject = async (
    expenseId: string,
    projectId: string | null
  ) => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/expenses/${expenseId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        }
      );

      if (!res.ok) {
        throw new Error("Failed to update expense");
      }

      // Refetch to get updated project/client relations
      fetchExpenses();
    } catch (err) {
      console.error("Error changing expense project:", err);
      toast.error("Failed to update expense");
    }
  };

  const deleteExpense = async (expenseId: string) => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/expenses/${expenseId}`,
        {
          method: "DELETE",
        }
      );

      if (!res.ok) {
        throw new Error("Failed to delete expense");
      }

      // Remove from local state
      setExpenses((prev) => prev.filter((e) => e.id !== expenseId));
      toast.success("Expense deleted");
    } catch (err) {
      console.error("Error deleting expense:", err);
      toast.error("Failed to delete expense");
      // Refetch to ensure consistency
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

  // Group expenses by date
  const dayGroups = groupExpensesByDate(expenses);

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
      <div className="space-y-6">
        {/* Month navigation header */}
        <ExpenseMonthHeader
          monthRange={monthRange}
          summary={summary}
          onPreviousMonth={goToPreviousMonth}
          onNextMonth={goToNextMonth}
          onThisMonth={goToThisMonth}
          isCurrentMonthView={isCurrentMonthView}
        />

        {/* Quick add bar */}
        <ExpenseQuickAdd orgId={orgId} onExpenseCreated={fetchExpenses} />

        <div className="h-px bg-border" />

        {/* Day groups */}
        {dayGroups.length === 0 ? (
          <Card className="squircle">
            <CardContent className="py-12 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
                <Receipt className="size-6 text-muted-foreground" />
              </div>
              <h3 className="mt-4 text-lg font-medium">No expenses this month</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Use the form above to track an expense.
              </p>
            </CardContent>
          </Card>
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
                onUpdateExpense={updateExpense}
                onDeleteExpense={deleteExpense}
                onDuplicateExpense={duplicateExpense}
                onProjectChange={changeExpenseProject}
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
      </div>
    </TooltipProvider>
  );
}
