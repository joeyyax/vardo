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
  onDeleteExpense: (expenseId: string) => Promise<void>;
  onDuplicateExpense: (expense: Expense) => Promise<void>;
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
  onDeleteExpense,
  onDuplicateExpense,
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
            onDelete={onDeleteExpense}
            onDuplicate={onDuplicateExpense}
            onExpenseClick={onExpenseClick}
            isHighlighted={highlightedExpenseId === expense.id}
            onClearHighlight={onClearHighlight}
          />
        ))}
      </div>
    </div>
  );
}
