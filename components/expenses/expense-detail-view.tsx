"use client";

import { format, parseISO } from "date-fns";
import { DollarSign, Building2, RefreshCw, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Expense } from "./types";

type ExpenseDetailViewProps = {
  expense: Expense;
  onEdit: () => void;
};

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function ExpenseDetailView({ expense, onEdit }: ExpenseDetailViewProps) {
  const isOverhead = !expense.project;

  return (
    <div className="space-y-4">
      {/* Main headline: Amount + Description */}
      <div>
        <div className="flex items-baseline gap-2">
          <span className={cn(
            "text-2xl font-semibold tabular-nums",
            expense.isBillable && "text-green-600 dark:text-green-400"
          )}>
            {formatCurrency(expense.amountCents)}
          </span>
          <span className="text-lg text-muted-foreground">·</span>
          <span className="text-lg font-medium truncate">{expense.description}</span>
        </div>
      </div>

      {/* Details row: Category, Client/Project */}
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {expense.category && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-muted text-foreground">
            {expense.category}
          </span>
        )}
        <span>·</span>
        {isOverhead ? (
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <Building2 className="size-3.5" />
            Overhead
          </span>
        ) : (
          <span>
            {expense.project?.client.name} / {expense.project?.name}
          </span>
        )}
      </div>

      {/* Date and status row */}
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{format(parseISO(expense.date), "MMMM d, yyyy")}</span>
        {expense.vendor && (
          <>
            <span>·</span>
            <span>{expense.vendor}</span>
          </>
        )}
        <span>·</span>
        <span className={cn(
          expense.status === "unpaid" && "text-red-600 dark:text-red-400 font-medium"
        )}>
          {expense.status === "unpaid" ? "Unpaid" : "Paid"}
        </span>
      </div>

      {/* Badges row */}
      <div className="flex flex-wrap items-center gap-2">
        {expense.isBillable && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/40">
            <DollarSign className="size-3" />
            Billable
          </span>
        )}
        {expense.isRecurring && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/40">
            <RefreshCw className="size-3" />
            {expense.recurringFrequency}
          </span>
        )}
      </div>

      {/* Receipt if attached */}
      {expense.receiptFile && (
        <div className="flex items-center gap-2 text-sm">
          <Paperclip className="size-4 text-muted-foreground" />
          <span>{expense.receiptFile.name}</span>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
            View
          </Button>
        </div>
      )}

      {/* Edit button */}
      <div className="pt-2">
        <Button onClick={onEdit} variant="outline" className="squircle">
          Edit
        </Button>
      </div>
    </div>
  );
}
