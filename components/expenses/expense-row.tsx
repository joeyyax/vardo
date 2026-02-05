"use client";

import { useState, useRef, useEffect } from "react";
import {
  Copy,
  Trash2,
  DollarSign,
  Building2,
  RefreshCw,
  Paperclip,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Expense } from "./types";
import { formatCurrency } from "./utils";

type ExpenseRowProps = {
  expense: Expense;
  orgId: string;
  currentUserId: string;
  onDelete: (expenseId: string) => Promise<void>;
  onDuplicate: (expense: Expense) => Promise<void>;
  onExpenseClick?: (expense: Expense) => void;
  isHighlighted?: boolean;
  onClearHighlight?: () => void;
};

export function ExpenseRow({
  expense,
  orgId,
  currentUserId,
  onDelete,
  onDuplicate,
  onExpenseClick,
  isHighlighted,
  onClearHighlight,
}: ExpenseRowProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const rowRef = useRef<HTMLDivElement>(null);

  const isOverhead = !expense.project;

  // Scroll into view and clear highlight after a delay
  useEffect(() => {
    if (isHighlighted && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      const timer = setTimeout(() => {
        onClearHighlight?.();
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [isHighlighted, onClearHighlight]);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await onDelete(expense.id);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleDuplicate = () => {
    onDuplicate(expense);
  };

  const clientColor = expense.project?.client.color || "#94a3b8";

  return (
    <>
      <div
        ref={rowRef}
        className={cn(
          "group flex items-center gap-4 py-2 px-3 -mx-3 rounded-lg transition-colors cursor-pointer",
          isHovered && "bg-muted/50",
          isHighlighted && "ring-2 ring-primary ring-offset-2 bg-primary/5"
        )}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={() => onExpenseClick?.(expense)}
      >
        {/* Color indicator */}
        {isOverhead ? (
          <div className="flex size-3 items-center justify-center shrink-0">
            <Building2 className="size-3 text-amber-500" />
          </div>
        ) : (
          <div
            className="size-3 rounded-full shrink-0"
            style={{ backgroundColor: clientColor }}
          />
        )}

        {/* Description + context cluster */}
        <div className="flex items-center gap-8 min-w-0">
          <span className="text-sm truncate">
            {expense.description}
          </span>

          {/* Badges */}
          <div className="flex items-center gap-3 shrink-0">
            {/* Project/Client */}
            {isOverhead ? (
              <span className="text-xs text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 rounded shrink-0">
                Overhead
              </span>
            ) : expense.project && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="bg-muted/60 text-xs px-2 py-0.5 rounded truncate max-w-[200px]">
                    {expense.project.client.name} / {expense.project.name}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="text-xs">
                    <div className="font-medium">{expense.project.name}</div>
                    <div className="text-muted-foreground">
                      {expense.project.client.name}
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Category badge */}
            {expense.category && (
              <span className="bg-muted/60 text-xs px-2 py-0.5 rounded shrink-0">
                {expense.category}
              </span>
            )}
          </div>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Recurring indicator */}
        {expense.isRecurring && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="size-6 flex items-center justify-center text-blue-500">
                <RefreshCw className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Recurring {expense.recurringFrequency}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Receipt indicator */}
        {expense.receiptFile && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="size-6 flex items-center justify-center text-muted-foreground">
                <Paperclip className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Receipt: {expense.receiptFile.name}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Billable indicator */}
        <span
          className={cn(
            "size-6 flex items-center justify-center rounded",
            expense.isBillable
              ? "text-green-600"
              : "text-muted-foreground/40",
            isOverhead && "opacity-50"
          )}
        >
          <DollarSign className="size-4" />
        </span>

        {/* Amount */}
        <div className="w-20 text-right">
          <span
            className={cn(
              "text-sm font-medium tabular-nums",
              expense.isBillable && "text-green-600 dark:text-green-400"
            )}
          >
            {formatCurrency(expense.amountCents)}
          </span>
        </div>

        {/* Actions (visible on hover) */}
        <div
          className={cn(
            "flex items-center gap-1 transition-opacity",
            isHovered ? "opacity-100" : "opacity-0"
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleDuplicate}
                className="text-muted-foreground hover:text-foreground"
              >
                <Copy className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Duplicate</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setShowDeleteConfirm(true)}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent className="squircle">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete expense?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &quot;{expense.description}&quot;.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting} className="squircle">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </>
  );
}
