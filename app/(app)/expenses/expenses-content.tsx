"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Building2,
  DollarSign,
  Eye,
  Loader2,
  MoreVertical,
  Plus,
  Receipt,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ExpenseDialog } from "./expense-dialog";

type Expense = {
  id: string;
  description: string;
  amountCents: number;
  date: string;
  category: string | null;
  isBillable: boolean;
  isRecurring: boolean;
  recurringFrequency: string | null;
  project: {
    id: string;
    name: string;
    client: {
      id: string;
      name: string;
      color: string | null;
    };
  } | null;
  receiptFile?: {
    id: string;
    name: string;
    mimeType: string;
  } | null;
  createdByUser?: {
    id: string;
    name: string | null;
    email: string;
  } | null;
};

type ExpensesContentProps = {
  orgId: string;
};

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function ExpensesContent({ orgId }: ExpensesContentProps) {
  const router = useRouter();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [categories, setCategories] = useState<string[]>([]);
  const [summary, setSummary] = useState<{
    totalCents: number;
    billableCents: number;
    nonBillableCents: number;
    overheadCents: number;
    count: number;
  } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const fetchExpenses = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (categoryFilter !== "all") {
        params.set("category", categoryFilter);
      }
      if (typeFilter === "billable") {
        params.set("billable", "true");
      } else if (typeFilter === "overhead") {
        params.set("overhead", "true");
      } else if (typeFilter === "recurring") {
        params.set("recurring", "true");
      }

      const response = await fetch(
        `/api/v1/organizations/${orgId}/expenses?${params}`
      );
      if (response.ok) {
        const data = await response.json();
        setExpenses(data.expenses);
        setSummary(data.summary);
        setCategories(data.categories || []);
      }
    } catch (err) {
      console.error("Error fetching expenses:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, categoryFilter, typeFilter]);

  useEffect(() => {
    fetchExpenses();
  }, [fetchExpenses]);

  function handleExpenseCreated() {
    fetchExpenses();
    setDialogOpen(false);
  }

  return (
    <div className="space-y-6">
      {/* Filters and summary */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[150px] squircle">
              <SelectValue placeholder="All expenses" />
            </SelectTrigger>
            <SelectContent className="squircle">
              <SelectItem value="all">All expenses</SelectItem>
              <SelectItem value="project">Project expenses</SelectItem>
              <SelectItem value="overhead">Overhead only</SelectItem>
              <SelectItem value="recurring">Recurring only</SelectItem>
              <SelectItem value="billable">Billable only</SelectItem>
            </SelectContent>
          </Select>

          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-[160px] squircle">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent className="squircle">
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {cat}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-4">
          {/* Summary badges */}
          {summary && (
            <div className="flex items-center gap-4 text-sm">
              <span className="text-muted-foreground">
                {summary.count} expenses
              </span>
              <span className="font-medium">
                {formatCurrency(summary.totalCents)} total
              </span>
              {summary.overheadCents > 0 && (
                <span className="text-amber-600 dark:text-amber-400">
                  {formatCurrency(summary.overheadCents)} overhead
                </span>
              )}
              {summary.billableCents > 0 && (
                <span className="text-green-600 dark:text-green-400">
                  {formatCurrency(summary.billableCents)} billable
                </span>
              )}
            </div>
          )}

          <Button onClick={() => setDialogOpen(true)} className="squircle">
            <Plus className="size-4" />
            New Expense
          </Button>
        </div>
      </div>

      {/* Expenses list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : expenses.length === 0 ? (
        <Card className="squircle">
          <CardContent className="py-12 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
              <Receipt className="size-6 text-muted-foreground" />
            </div>
            <h3 className="mt-4 text-lg font-medium">No expenses yet</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Track project costs and overhead expenses.
            </p>
            <Button onClick={() => setDialogOpen(true)} className="mt-4 squircle">
              <Plus className="size-4" />
              Add Expense
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {expenses.map((expense) => {
            const isOverhead = !expense.project;

            return (
              <Card
                key={expense.id}
                className={cn(
                  "squircle hover:bg-accent/50 transition-colors",
                  expense.project && "cursor-pointer"
                )}
                onClick={() => expense.project && router.push(`/projects/${expense.project.id}`)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4 min-w-0">
                      {/* Color indicator */}
                      {isOverhead ? (
                        <div className="flex size-3 items-center justify-center shrink-0">
                          <Building2 className="size-3 text-amber-500" />
                        </div>
                      ) : (
                        <div
                          className="size-3 rounded-full shrink-0"
                          style={{ backgroundColor: expense.project?.client.color || "#94a3b8" }}
                        />
                      )}

                      {/* Expense info */}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{expense.description}</span>
                          {expense.isBillable && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900">
                              <DollarSign className="size-3" />
                              Billable
                            </span>
                          )}
                          {expense.isRecurring && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900">
                              <RefreshCw className="size-3" />
                              {expense.recurringFrequency}
                            </span>
                          )}
                          {isOverhead && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900">
                              Overhead
                            </span>
                          )}
                          {expense.category && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs text-muted-foreground bg-muted">
                              {expense.category}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground mt-0.5">
                          {isOverhead ? (
                            <span>General Business</span>
                          ) : (
                            <>
                              <span>{expense.project?.client.name}</span>
                              <span>&middot;</span>
                              <span>{expense.project?.name}</span>
                            </>
                          )}
                          <span>&middot;</span>
                          <span>{format(new Date(expense.date), "MMM d, yyyy")}</span>
                        </div>
                      </div>
                    </div>

                    {/* Amount and actions */}
                    <div className="flex items-center gap-4">
                      <span className={cn(
                        "font-medium tabular-nums",
                        expense.isBillable ? "text-green-600 dark:text-green-400" : ""
                      )}>
                        {formatCurrency(expense.amountCents)}
                      </span>

                      {expense.project && (
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
                                router.push(`/projects/${expense.project!.id}`);
                              }}
                            >
                              <Eye className="size-4" />
                              View Project
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ExpenseDialog
        orgId={orgId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={handleExpenseCreated}
      />
    </div>
  );
}
