"use client";

import { useState, useRef, useEffect, KeyboardEvent } from "react";
import {
  Copy,
  Trash2,
  DollarSign,
  Building2,
  RefreshCw,
  Paperclip,
  MessageSquare,
  CalendarIcon,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExpenseComments } from "./expense-comments";
import type { Expense } from "./types";
import { formatCurrency, parseCurrency, DEFAULT_CATEGORIES } from "./utils";
import { ProjectSelector } from "./project-selector";

type ExpenseRowProps = {
  expense: Expense;
  orgId: string;
  currentUserId: string;
  onUpdate: (
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
  onDelete: (expenseId: string) => Promise<void>;
  onDuplicate: (expense: Expense) => Promise<void>;
  onProjectChange: (expenseId: string, projectId: string | null) => Promise<void>;
  onExpenseClick?: (expense: Expense) => void;
  isHighlighted?: boolean;
  onClearHighlight?: () => void;
};

type EditingField = "description" | "amount" | null;

export function ExpenseRow({
  expense,
  orgId,
  currentUserId,
  onUpdate,
  onDelete,
  onDuplicate,
  onProjectChange,
  onExpenseClick,
  isHighlighted,
  onClearHighlight,
}: ExpenseRowProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [editingField, setEditingField] = useState<EditingField>(null);
  const [editValue, setEditValue] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
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

  // Focus input when editing starts
  useEffect(() => {
    if (editingField && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingField]);

  const startEditing = (field: EditingField) => {
    if (field === "description") {
      setEditValue(expense.description);
    } else if (field === "amount") {
      setEditValue((expense.amountCents / 100).toFixed(2));
    }
    setEditingField(field);
  };

  const cancelEditing = () => {
    setEditingField(null);
    setEditValue("");
  };

  const saveEdit = async () => {
    if (!editingField || isSaving) return;

    setIsSaving(true);
    try {
      if (editingField === "description") {
        const newDescription = editValue.trim();
        if (newDescription && newDescription !== expense.description) {
          await onUpdate(expense.id, { description: newDescription });
        }
      } else if (editingField === "amount") {
        const newCents = parseCurrency(editValue);
        if (newCents !== null && newCents > 0 && newCents !== expense.amountCents) {
          await onUpdate(expense.id, { amountCents: newCents });
        }
      }
    } finally {
      setIsSaving(false);
      setEditingField(null);
      setEditValue("");
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      cancelEditing();
    } else if (e.key === "Enter") {
      saveEdit();
    }
  };

  const handleCategoryChange = async (category: string) => {
    const newCategory = category === "none" ? null : category;
    if (newCategory !== expense.category) {
      await onUpdate(expense.id, { category: newCategory });
    }
  };

  const handleDateChange = async (newDate: Date | undefined) => {
    if (!newDate) return;
    const dateStr = format(newDate, "yyyy-MM-dd");
    if (dateStr !== expense.date) {
      await onUpdate(expense.id, { date: dateStr });
    }
    setDatePickerOpen(false);
  };

  const toggleBillable = async () => {
    // Can only toggle billable on project expenses
    if (!expense.project) return;
    await onUpdate(expense.id, { isBillable: !expense.isBillable });
  };

  const handleProjectSelect = async (projectId: string | null) => {
    if (projectId === expense.project?.id) return;
    await onProjectChange(expense.id, projectId);
  };

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
        onDoubleClick={() => onExpenseClick?.(expense)}
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

        {/* Description */}
        <div className="flex-1 min-w-0">
          {editingField === "description" ? (
            <Input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={saveEdit}
              onKeyDown={handleKeyDown}
              placeholder="What was this expense for?"
              className="h-7 text-sm"
              disabled={isSaving}
            />
          ) : (
            <button
              onClick={() => startEditing("description")}
              className="text-left text-sm truncate block w-full hover:text-primary transition-colors"
            >
              {expense.description}
            </button>
          )}
        </div>

        {/* Category badge */}
        <Select
          value={expense.category || "none"}
          onValueChange={handleCategoryChange}
        >
          <SelectTrigger className="h-6 w-auto min-w-[80px] border-0 bg-muted/60 text-xs px-2 gap-1 focus:ring-0">
            <SelectValue>
              {expense.category || (
                <span className="text-muted-foreground">Category</span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
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

        {/* Project/Client info - clickable to change */}
        <ProjectSelector
          orgId={orgId}
          selectedProjectId={expense.project?.id || null}
          onSelect={handleProjectSelect}
          open={projectSelectorOpen}
          onOpenChange={setProjectSelectorOpen}
        >
          <button className="min-w-[120px] max-w-[180px] text-left hover:opacity-80 transition-opacity">
            {isOverhead ? (
              <span className="text-xs text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 rounded inline-block">
                Overhead
              </span>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs text-muted-foreground truncate block">
                    {expense.project?.name}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="text-xs">
                    <div className="font-medium">{expense.project?.name}</div>
                    <div className="text-muted-foreground">
                      {expense.project?.client.name}
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
          </button>
        </ProjectSelector>

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
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={toggleBillable}
              disabled={isOverhead}
              className={cn(
                "size-6 flex items-center justify-center rounded transition-colors",
                expense.isBillable
                  ? "text-green-600 hover:text-green-700"
                  : "text-muted-foreground/40 hover:text-muted-foreground",
                isOverhead && "cursor-not-allowed opacity-50"
              )}
            >
              <DollarSign className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {isOverhead
              ? "Overhead expenses can't be billed"
              : expense.isBillable
                ? "Billable"
                : "Non-billable"}
          </TooltipContent>
        </Tooltip>

        {/* Amount */}
        <div className="w-20 text-right">
          {editingField === "amount" ? (
            <Input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={saveEdit}
              onKeyDown={handleKeyDown}
              placeholder="0.00"
              className="h-7 text-sm text-right w-20"
              disabled={isSaving}
            />
          ) : (
            <button
              onClick={() => startEditing("amount")}
              className={cn(
                "text-sm font-medium tabular-nums hover:text-primary transition-colors",
                expense.isBillable && "text-green-600 dark:text-green-400"
              )}
            >
              {formatCurrency(expense.amountCents)}
            </button>
          )}
        </div>

        {/* Actions (visible on hover) */}
        <div
          className={cn(
            "flex items-center gap-1 transition-opacity",
            isHovered ? "opacity-100" : "opacity-0"
          )}
        >
          {/* Date picker */}
          <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <CalendarIcon className="size-3.5" />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>
                Change date ({format(parseISO(expense.date), "MMM d, yyyy")})
              </TooltipContent>
            </Tooltip>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="single"
                selected={parseISO(expense.date)}
                onSelect={handleDateChange}
                initialFocus
              />
            </PopoverContent>
          </Popover>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setShowComments(true)}
                className="text-muted-foreground hover:text-foreground"
              >
                <MessageSquare className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Comments</TooltipContent>
          </Tooltip>

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

      {/* Comments dialog */}
      <Dialog open={showComments} onOpenChange={setShowComments}>
        <DialogContent className="squircle max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="truncate pr-8">{expense.description}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto">
            <ExpenseComments
              orgId={orgId}
              expenseId={expense.id}
              currentUserId={currentUserId}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
