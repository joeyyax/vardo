"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
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
  Download,
  Eye,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Receipt,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ExpenseDialog } from "./expense-dialog";
import { ExpenseDetailModal } from "@/components/expenses/expense-detail-modal";
import type { Expense } from "@/components/expenses/types";

// List row component for borderless items
interface ListRowProps {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  isLast?: boolean;
}

function ListRow({ children, onClick, className, isLast }: ListRowProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "group flex items-center gap-4 px-3 py-3 hover:bg-card/40 transition-colors cursor-pointer",
        !isLast && "border-b border-border/40",
        className
      )}
    >
      {children}
    </div>
  );
}

type ExpensesContentProps = {
  orgId: string;
  currentUserId: string;
};

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function ExpensesContent({ orgId, currentUserId }: ExpensesContentProps) {
  const router = useRouter();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [vendorFilter, setVendorFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [categories, setCategories] = useState<string[]>([]);
  const [clients, setClients] = useState<Array<{ id: string; name: string; color: string | null }>>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [summary, setSummary] = useState<{
    totalCents: number;
    billableCents: number;
    nonBillableCents: number;
    overheadCents: number;
    count: number;
  } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [detailExpense, setDetailExpense] = useState<Expense | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);

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
      if (clientFilter !== "all") {
        params.set("clientId", clientFilter);
      }
      if (vendorFilter !== "all") {
        params.set("vendor", vendorFilter);
      }
      if (statusFilter !== "all") {
        params.set("status", statusFilter);
      }

      const response = await fetch(
        `/api/v1/organizations/${orgId}/expenses?${params}`
      );
      if (response.ok) {
        const data = await response.json();
        setExpenses(data.expenses);
        setSummary(data.summary);
        setCategories(data.categories || []);
        setVendors(data.vendors || []);
      }
    } catch (err) {
      console.error("Error fetching expenses:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, categoryFilter, typeFilter, clientFilter, vendorFilter, statusFilter]);

  useEffect(() => {
    fetchExpenses();
  }, [fetchExpenses]);

  useEffect(() => {
    async function fetchClients() {
      try {
        const response = await fetch(`/api/v1/organizations/${orgId}/clients`);
        if (response.ok) {
          const data = await response.json();
          setClients(data);
        }
      } catch (err) {
        console.error("Error fetching clients:", err);
      }
    }
    fetchClients();
  }, [orgId]);

  function handleExport() {
    const params = new URLSearchParams();
    if (clientFilter !== "all") params.set("clientId", clientFilter);
    if (categoryFilter !== "all") params.set("category", categoryFilter);
    if (vendorFilter !== "all") params.set("vendor", vendorFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (typeFilter === "billable") params.set("billable", "true");
    if (typeFilter === "overhead") params.set("overhead", "true");
    if (typeFilter === "recurring") params.set("recurring", "true");

    window.open(`/api/v1/organizations/${orgId}/expenses/export?${params}`, "_blank");
  }

  function handleExpenseCreated() {
    fetchExpenses();
    setDialogOpen(false);
    setEditingExpense(null);
  }

  function handleEditExpense(expense: Expense) {
    setEditingExpense(expense);
    setDialogOpen(true);
  }

  function handleDialogClose(open: boolean) {
    setDialogOpen(open);
    if (!open) {
      setEditingExpense(null);
    }
  }

  function handleExpenseClick(expense: Expense) {
    setDetailExpense(expense);
    setDetailModalOpen(true);
  }

  function handleDetailModalClose(open: boolean) {
    setDetailModalOpen(open);
    if (!open) {
      setDetailExpense(null);
    }
  }

  async function handleDeleteExpense(expense: Expense) {
    if (!confirm(`Delete "${expense.description}"? This cannot be undone.`)) {
      return;
    }

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/expenses/${expense.id}`,
        { method: "DELETE" }
      );

      if (response.ok) {
        toast.success("Expense deleted");
        fetchExpenses();
      } else {
        const data = await response.json();
        toast.error(data.error || "Failed to delete expense");
      }
    } catch (err) {
      console.error("Error deleting expense:", err);
      toast.error("Failed to delete expense");
    }
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

          <Select value={clientFilter} onValueChange={setClientFilter}>
            <SelectTrigger className="w-[160px] squircle">
              <SelectValue placeholder="All clients" />
            </SelectTrigger>
            <SelectContent className="squircle">
              <SelectItem value="all">All clients</SelectItem>
              {clients.map((client) => (
                <SelectItem key={client.id} value={client.id}>
                  <div className="flex items-center gap-2">
                    {client.color && (
                      <div
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: client.color }}
                      />
                    )}
                    {client.name}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={vendorFilter} onValueChange={setVendorFilter}>
            <SelectTrigger className="w-[140px] squircle">
              <SelectValue placeholder="All vendors" />
            </SelectTrigger>
            <SelectContent className="squircle">
              <SelectItem value="all">All vendors</SelectItem>
              {vendors.map((vendor) => (
                <SelectItem key={vendor} value={vendor}>
                  {vendor}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[120px] squircle">
              <SelectValue placeholder="All status" />
            </SelectTrigger>
            <SelectContent className="squircle">
              <SelectItem value="all">All status</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="unpaid">Unpaid</SelectItem>
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

          <Button variant="outline" onClick={handleExport} className="squircle">
            <Download className="size-4" />
            Export
          </Button>

          <Button onClick={() => setDialogOpen(true)} className="squircle">
            <Plus className="size-4" />
            New Expense
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Need full tax export?{" "}
        <Link href="/reports?tab=accounting" className="text-primary hover:underline">
          Go to Accounting →
        </Link>
      </p>

      {/* Expenses list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : expenses.length === 0 ? (
        <div className="py-12 text-center">
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
        </div>
      ) : (
        <div className="bg-card/30 ring-1 ring-border/40">
          {expenses.map((expense, index) => {
            const isOverhead = !expense.project;
            const isLast = index === expenses.length - 1;

            return (
              <ListRow
                key={expense.id}
                onClick={() => handleExpenseClick(expense)}
                isLast={isLast}
              >
                {/* Left content */}
                <div className="flex items-center gap-4 min-w-0 flex-1">
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
                      {expense.status === "unpaid" && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900">
                          Unpaid
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
                          <span className="text-muted-foreground/50">&middot;</span>
                          <span>{expense.project?.name}</span>
                        </>
                      )}
                      <span className="text-muted-foreground/50">&middot;</span>
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

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon" className="size-8 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        <MoreVertical className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="squircle">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditExpense(expense);
                        }}
                      >
                        <Pencil className="size-4" />
                        Edit
                      </DropdownMenuItem>
                      {expense.project && (
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(`/projects/${expense.project!.id}`);
                          }}
                        >
                          <Eye className="size-4" />
                          View Project
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteExpense(expense);
                        }}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </ListRow>
            );
          })}
        </div>
      )}

      <ExpenseDialog
        orgId={orgId}
        open={dialogOpen}
        onOpenChange={handleDialogClose}
        onSuccess={handleExpenseCreated}
        expense={editingExpense}
      />

      <ExpenseDetailModal
        orgId={orgId}
        currentUserId={currentUserId}
        expense={detailExpense}
        open={detailModalOpen}
        onOpenChange={handleDetailModalClose}
        onUpdate={fetchExpenses}
      />
    </div>
  );
}
