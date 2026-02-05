"use client";

import { useState, useEffect, useCallback } from "react";
import { format, parseISO } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DollarSign,
  Edit,
  Loader2,
  MoreVertical,
  Plus,
  Receipt,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

type Expense = {
  id: string;
  description: string;
  amountCents: number;
  date: string;
  category: string | null;
  isBillable: boolean;
  receiptFileId: string | null;
  createdAt: string;
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

type ExpenseSummary = {
  totalCents: number;
  billableCents: number;
  nonBillableCents: number;
  count: number;
};

type ProjectExpensesProps = {
  orgId: string;
  projectId: string;
};

const DEFAULT_CATEGORIES = [
  "Software",
  "Hosting",
  "Contractor",
  "Travel",
  "Supplies",
  "Equipment",
  "Other",
];

export function ProjectExpenses({ orgId, projectId }: ProjectExpensesProps) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [summary, setSummary] = useState<ExpenseSummary | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [deleteExpense, setDeleteExpense] = useState<Expense | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form state
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [category, setCategory] = useState("");
  const [isBillable, setIsBillable] = useState(false);

  const fetchExpenses = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/expenses`
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
  }, [orgId, projectId]);

  useEffect(() => {
    fetchExpenses();
  }, [fetchExpenses]);

  function resetForm() {
    setDescription("");
    setAmount("");
    setDate(format(new Date(), "yyyy-MM-dd"));
    setCategory("");
    setIsBillable(false);
    setEditingExpense(null);
  }

  function openCreateDialog() {
    resetForm();
    setDialogOpen(true);
  }

  function openEditDialog(expense: Expense) {
    setEditingExpense(expense);
    setDescription(expense.description);
    setAmount((expense.amountCents / 100).toFixed(2));
    setDate(expense.date);
    setCategory(expense.category || "");
    setIsBillable(expense.isBillable);
    setDialogOpen(true);
  }

  async function handleSubmit() {
    if (!description.trim()) {
      toast.error("Description is required");
      return;
    }

    const amountValue = parseFloat(amount);
    if (isNaN(amountValue) || amountValue <= 0) {
      toast.error("Valid amount is required");
      return;
    }

    setIsSubmitting(true);
    try {
      const url = editingExpense
        ? `/api/v1/organizations/${orgId}/projects/${projectId}/expenses/${editingExpense.id}`
        : `/api/v1/organizations/${orgId}/projects/${projectId}/expenses`;

      const response = await fetch(url, {
        method: editingExpense ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          amountCents: Math.round(amountValue * 100),
          date,
          category: category || null,
          isBillable,
        }),
      });

      if (response.ok) {
        setDialogOpen(false);
        resetForm();
        fetchExpenses();
        toast.success(editingExpense ? "Expense updated" : "Expense added");
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to save expense");
      }
    } catch {
      toast.error("Failed to save expense");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deleteExpense) return;

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/expenses/${deleteExpense.id}`,
        { method: "DELETE" }
      );

      if (response.ok) {
        fetchExpenses();
        toast.success("Expense deleted");
      } else {
        toast.error("Failed to delete expense");
      }
    } catch {
      toast.error("Failed to delete expense");
    } finally {
      setDeleteExpense(null);
    }
  }

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  };

  // Merge default categories with existing ones
  const allCategories = [...new Set([...DEFAULT_CATEGORIES, ...categories])].sort();

  return (
    <Card className="squircle">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Receipt className="size-5" />
              Expenses
            </CardTitle>
            <CardDescription>
              {summary ? (
                <>
                  {formatCurrency(summary.totalCents)} total
                  {summary.billableCents > 0 && (
                    <> &middot; {formatCurrency(summary.billableCents)} billable</>
                  )}
                </>
              ) : (
                "Track project costs"
              )}
            </CardDescription>
          </div>
          <Button size="sm" onClick={openCreateDialog} className="squircle">
            <Plus className="size-4" />
            Add
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : expenses.length === 0 ? (
          <div className="text-center py-8">
            <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
              <DollarSign className="size-5 text-muted-foreground" />
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              No expenses recorded
            </p>
            <Button
              variant="link"
              size="sm"
              onClick={openCreateDialog}
              className="mt-2"
            >
              Add your first expense
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {expenses.map((expense) => (
              <div
                key={expense.id}
                className="flex items-center justify-between gap-3 p-3 rounded-lg border"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{expense.description}</span>
                    {expense.isBillable && (
                      <span className="text-xs bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 px-1.5 py-0.5 rounded">
                        Billable
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                    <span>{format(parseISO(expense.date), "MMM d, yyyy")}</span>
                    {expense.category && (
                      <>
                        <span>&middot;</span>
                        <span>{expense.category}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {formatCurrency(expense.amountCents)}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-8">
                        <MoreVertical className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="squircle">
                      <DropdownMenuItem onClick={() => openEditDialog(expense)}>
                        <Edit className="size-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setDeleteExpense(expense)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open) resetForm();
      }}>
        <DialogContent className="squircle">
          <DialogHeader>
            <DialogTitle>
              {editingExpense ? "Edit Expense" : "Add Expense"}
            </DialogTitle>
            <DialogDescription>
              Record a project-related expense.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Software license, hosting, etc."
                className="squircle"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="amount">Amount</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="amount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="squircle pl-7"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="date">Date</Label>
                <Input
                  id="date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="squircle"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="category">Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="category" className="squircle">
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent className="squircle">
                  {allCategories.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="billable"
                checked={isBillable}
                onCheckedChange={setIsBillable}
              />
              <Label htmlFor="billable" className="cursor-pointer">
                Billable to client
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={isSubmitting}
              className="squircle"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting || !description.trim() || !amount}
              className="squircle"
            >
              {isSubmitting && <Loader2 className="size-4 animate-spin" />}
              {editingExpense ? "Update" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <AlertDialog open={!!deleteExpense} onOpenChange={() => setDeleteExpense(null)}>
        <AlertDialogContent className="squircle">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete expense?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this expense. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="squircle">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
