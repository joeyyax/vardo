"use client";

import type { Expense } from "./types";
import { ExpenseRow } from "./expense-row";
import { formatDayHeader, formatCurrency } from "./utils";

type ExpenseDayGroupProps = {
  date: string;
  expenses: Expense[];
  totalCents: number;
  orgId: string;
  currentUserId: string;
  onUpdateExpense: (
    expenseId: string,
    updates: Partial<{
      description: string;
      amountCents: number;
      category: string | null;
      isBillable: boolean;
      projectId: string | null;
      date: string;
    }>
  ) => Promise<void>;
  onDeleteExpense: (expenseId: string) => Promise<void>;
  onDuplicateExpense: (expense: Expense) => Promise<void>;
  onProjectChange: (expenseId: string, projectId: string | null) => Promise<void>;
  onExpenseClick?: (expense: Expense) => void;
  highlightedExpenseId?: string;
  onClearHighlight?: () => void;
};

export function ExpenseDayGroup({
  date,
  expenses,
  totalCents,
  orgId,
  currentUserId,
  onUpdateExpense,
  onDeleteExpense,
  onDuplicateExpense,
  onProjectChange,
  onExpenseClick,
  highlightedExpenseId,
  onClearHighlight,
}: ExpenseDayGroupProps) {
  return (
    <div className="space-y-2">
      {/* Day header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          {formatDayHeader(date)}
        </h3>
        <span className="text-sm font-medium tabular-nums">
          {formatCurrency(totalCents)}
        </span>
      </div>

      {/* Expense rows */}
      <div className="space-y-1">
        {expenses.map((expense) => (
          <ExpenseRow
            key={expense.id}
            expense={expense}
            orgId={orgId}
            currentUserId={currentUserId}
            onUpdate={onUpdateExpense}
            onDelete={onDeleteExpense}
            onDuplicate={onDuplicateExpense}
            onProjectChange={onProjectChange}
            onExpenseClick={onExpenseClick}
            isHighlighted={highlightedExpenseId === expense.id}
            onClearHighlight={onClearHighlight}
          />
        ))}
      </div>
    </div>
  );
}
