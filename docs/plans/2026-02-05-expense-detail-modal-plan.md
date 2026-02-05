# Expense Detail Modal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace inline expense editing with a detail modal that shows expense info (view/edit) on left and comments on right, while adding row-level quick-edit controls for common fields.

**Architecture:** Create a new `ExpenseDetailModal` component that manages view/edit state internally. Refactor `ExpensesContent` to open modal on row click. Keep existing `ExpenseDialog` for new expense creation. Add inline edit controls to expense rows for category, client/project, price, billable, and duplicate actions.

**Tech Stack:** React, shadcn/ui (Dialog, Select, Input, Switch), react-hook-form, zod, date-fns

---

## Task 1: Update Expense Type

**Files:**
- Modify: `components/expenses/types.ts`

**Step 1: Add vendor and status to Expense type**

```typescript
export type Expense = {
  id: string;
  description: string;
  amountCents: number;
  date: string;
  category: string | null;
  vendor?: string | null;
  status?: "paid" | "unpaid" | null;
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
```

**Step 2: Commit**

```bash
git add components/expenses/types.ts
git commit -m "feat(expenses): add vendor and status to Expense type"
```

---

## Task 2: Create ExpenseDetailView Component

**Files:**
- Create: `components/expenses/expense-detail-view.tsx`

**Step 1: Create compact view component**

```tsx
"use client";

import { format, parseISO } from "date-fns";
import { DollarSign, Building2, RefreshCw, Paperclip, FileText } from "lucide-react";
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
```

**Step 2: Commit**

```bash
git add components/expenses/expense-detail-view.tsx
git commit -m "feat(expenses): create ExpenseDetailView component"
```

---

## Task 3: Create ExpenseDetailEdit Component

**Files:**
- Create: `components/expenses/expense-detail-edit.tsx`

**Step 1: Create edit form component**

This component is similar to ExpenseDialog form but designed for in-modal editing.

```tsx
"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { format, addMonths, addWeeks, addYears } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { expenseSchema, type ExpenseFormData } from "@/lib/schemas/expense";
import type { Expense } from "./types";

type Project = {
  id: string;
  name: string;
  client: {
    id: string;
    name: string;
  };
};

type ExpenseDetailEditProps = {
  orgId: string;
  expense: Expense;
  onSave: () => void;
  onCancel: () => void;
};

const DEFAULT_CATEGORIES = [
  "Software",
  "Hosting",
  "Contractor",
  "Travel",
  "Supplies",
  "Equipment",
  "Marketing",
  "Insurance",
  "Subscriptions",
  "Other",
];

const RECURRING_FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

function calculateNextOccurrence(date: string, frequency: string): string {
  const d = new Date(date);
  switch (frequency) {
    case "weekly":
      return format(addWeeks(d, 1), "yyyy-MM-dd");
    case "monthly":
      return format(addMonths(d, 1), "yyyy-MM-dd");
    case "quarterly":
      return format(addMonths(d, 3), "yyyy-MM-dd");
    case "yearly":
      return format(addYears(d, 1), "yyyy-MM-dd");
    default:
      return format(addMonths(d, 1), "yyyy-MM-dd");
  }
}

export function ExpenseDetailEdit({
  orgId,
  expense,
  onSave,
  onCancel,
}: ExpenseDetailEditProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [vendors, setVendors] = useState<string[]>([]);

  const form = useForm<ExpenseFormData>({
    resolver: zodResolver(expenseSchema),
    defaultValues: {
      description: expense.description,
      amount: (expense.amountCents / 100).toString(),
      date: expense.date,
      category: expense.category || "",
      projectId: expense.project?.id || "none",
      isBillable: expense.isBillable,
      isRecurring: expense.isRecurring,
      recurringFrequency: expense.recurringFrequency || "monthly",
      vendor: expense.vendor || "",
      status: (expense.status as "paid" | "unpaid") || "paid",
    },
  });

  const isRecurring = form.watch("isRecurring");
  const projectId = form.watch("projectId");

  useEffect(() => {
    fetchProjects();
    fetchVendors();
  }, []);

  async function fetchVendors() {
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/expenses`);
      if (response.ok) {
        const data = await response.json();
        setVendors(data.vendors || []);
      }
    } catch (err) {
      console.error("Error fetching vendors:", err);
    }
  }

  async function fetchProjects() {
    setProjectsLoading(true);
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/projects`);
      if (response.ok) {
        const data = await response.json();
        setProjects(data.projects || data);
      }
    } catch (err) {
      console.error("Error fetching projects:", err);
    } finally {
      setProjectsLoading(false);
    }
  }

  async function onSubmit(data: ExpenseFormData) {
    const amountCents = Math.round(parseFloat(data.amount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      toast.error("Valid amount is required");
      return;
    }

    setIsLoading(true);
    try {
      const payload = {
        description: data.description.trim(),
        amountCents,
        date: data.date,
        category: data.category || null,
        projectId: data.projectId === "none" ? null : data.projectId,
        isBillable: data.isBillable,
        isRecurring: data.isRecurring,
        recurringFrequency: data.isRecurring ? data.recurringFrequency : null,
        nextOccurrence: data.isRecurring
          ? calculateNextOccurrence(data.date, data.recurringFrequency)
          : null,
        vendor: data.vendor || null,
        status: data.status || "paid",
      };

      const response = await fetch(
        `/api/v1/organizations/${orgId}/expenses/${expense.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      if (response.ok) {
        toast.success("Expense updated");
        onSave();
      } else {
        const responseData = await response.json();
        toast.error(responseData.error || "Failed to update expense");
      }
    } catch (err) {
      console.error("Error updating expense:", err);
      toast.error("Failed to update expense");
    } finally {
      setIsLoading(false);
    }
  }

  const projectsByClient = projects.reduce(
    (acc, project) => {
      const clientName = project.client.name;
      if (!acc[clientName]) {
        acc[clientName] = [];
      }
      acc[clientName].push(project);
      return acc;
    },
    {} as Record<string, Project[]>
  );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Input {...field} className="squircle" autoFocus />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="amount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Amount</FormLabel>
                <FormControl>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                      $
                    </span>
                    <Input
                      {...field}
                      type="number"
                      step="0.01"
                      min="0"
                      className="pl-7 squircle"
                    />
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{isRecurring ? "Start Date" : "Date"}</FormLabel>
                <FormControl>
                  <Input {...field} type="date" className="squircle" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="category"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Category</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="squircle">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className="squircle">
                  {DEFAULT_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="vendor"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Vendor</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  placeholder="e.g., Adobe, AWS"
                  className="squircle"
                  list="vendor-suggestions-edit"
                />
              </FormControl>
              <datalist id="vendor-suggestions-edit">
                {vendors.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="status"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Payment Status</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="squircle">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className="squircle">
                  <SelectItem value="paid">Paid</SelectItem>
                  <SelectItem value="unpaid">Unpaid</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="projectId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Project</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="squircle">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className="squircle">
                  <SelectItem value="none">
                    <span className="text-muted-foreground">
                      General Business (Overhead)
                    </span>
                  </SelectItem>
                  {projectsLoading ? (
                    <div className="flex items-center justify-center py-2">
                      <Loader2 className="size-4 animate-spin" />
                    </div>
                  ) : (
                    Object.entries(projectsByClient).map(
                      ([clientName, clientProjects]) => (
                        <div key={clientName}>
                          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                            {clientName}
                          </div>
                          {clientProjects.map((project) => (
                            <SelectItem key={project.id} value={project.id}>
                              {project.name}
                            </SelectItem>
                          ))}
                        </div>
                      )
                    )
                  )}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="isRecurring"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <RefreshCw className="size-4 text-muted-foreground" />
                <div className="space-y-0.5">
                  <FormLabel>Recurring expense</FormLabel>
                  <FormDescription>Auto-generate on schedule</FormDescription>
                </div>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />

        {isRecurring && (
          <FormField
            control={form.control}
            name="recurringFrequency"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Frequency</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="squircle">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="squircle">
                    {RECURRING_FREQUENCIES.map((freq) => (
                      <SelectItem key={freq.value} value={freq.value}>
                        {freq.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control}
          name="isBillable"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <FormLabel>Billable to client</FormLabel>
                <FormDescription>Include on client invoices</FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={projectId === "none"}
                />
              </FormControl>
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            className="squircle"
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isLoading} className="squircle">
            {isLoading && <Loader2 className="size-4 animate-spin" />}
            Save Changes
          </Button>
        </div>
      </form>
    </Form>
  );
}
```

**Step 2: Commit**

```bash
git add components/expenses/expense-detail-edit.tsx
git commit -m "feat(expenses): create ExpenseDetailEdit component"
```

---

## Task 4: Create ExpenseDetailModal Component

**Files:**
- Create: `components/expenses/expense-detail-modal.tsx`

**Step 1: Create modal wrapper with two-column layout**

```tsx
"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExpenseDetailView } from "./expense-detail-view";
import { ExpenseDetailEdit } from "./expense-detail-edit";
import { ExpenseComments } from "./expense-comments";
import type { Expense } from "./types";

type ExpenseDetailModalProps = {
  orgId: string;
  currentUserId: string;
  expense: Expense | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: () => void;
};

export function ExpenseDetailModal({
  orgId,
  currentUserId,
  expense,
  open,
  onOpenChange,
  onUpdate,
}: ExpenseDetailModalProps) {
  const [isEditing, setIsEditing] = useState(false);

  const handleClose = useCallback((open: boolean) => {
    if (!open) {
      setIsEditing(false);
    }
    onOpenChange(open);
  }, [onOpenChange]);

  const handleSave = useCallback(() => {
    setIsEditing(false);
    onUpdate();
  }, [onUpdate]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  if (!expense) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="squircle max-w-3xl max-h-[85vh] overflow-hidden p-0">
        <div className="flex h-full">
          {/* Left panel: Details (2/3 width) */}
          <div className="flex-[2] border-r overflow-y-auto p-6">
            <DialogHeader className="mb-4">
              <DialogTitle className="text-lg">Expense Details</DialogTitle>
            </DialogHeader>

            {isEditing ? (
              <ExpenseDetailEdit
                orgId={orgId}
                expense={expense}
                onSave={handleSave}
                onCancel={handleCancel}
              />
            ) : (
              <ExpenseDetailView
                expense={expense}
                onEdit={() => setIsEditing(true)}
              />
            )}
          </div>

          {/* Right panel: Comments (1/3 width) */}
          <div className="flex-1 flex flex-col overflow-hidden p-6">
            <h3 className="text-sm font-medium mb-4">Comments</h3>
            <div className="flex-1 overflow-y-auto">
              <ExpenseComments
                orgId={orgId}
                expenseId={expense.id}
                currentUserId={currentUserId}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Commit**

```bash
git add components/expenses/expense-detail-modal.tsx
git commit -m "feat(expenses): create ExpenseDetailModal with two-column layout"
```

---

## Task 5: Add Index Export for New Components

**Files:**
- Create: `components/expenses/index.ts`

**Step 1: Create barrel export**

```tsx
export { ExpenseDetailModal } from "./expense-detail-modal";
export { ExpenseDetailView } from "./expense-detail-view";
export { ExpenseDetailEdit } from "./expense-detail-edit";
export { ExpenseComments, ExpenseCommentCount } from "./expense-comments";
export { ExpenseRow } from "./expense-row";
export { ExpenseTimeline } from "./expense-timeline";
export { ExpenseDayGroup } from "./expense-day-group";
export { ExpenseQuickAdd } from "./expense-quick-add";
export { ExpenseMonthHeader } from "./expense-month-header";
export { ProjectSelector } from "./project-selector";
export * from "./types";
export * from "./utils";
```

**Step 2: Commit**

```bash
git add components/expenses/index.ts
git commit -m "feat(expenses): add barrel export"
```

---

## Task 6: Integrate Modal into ExpensesContent

**Files:**
- Modify: `app/(app)/expenses/expenses-content.tsx`

**Step 1: Import modal and add state**

Add import at top:
```tsx
import { ExpenseDetailModal } from "@/components/expenses/expense-detail-modal";
```

Add state near other useState declarations (around line 103-104):
```tsx
const [detailExpense, setDetailExpense] = useState<Expense | null>(null);
const [detailModalOpen, setDetailModalOpen] = useState(false);
```

**Step 2: Add handler function**

Add after `handleDialogClose` function (around line 195):
```tsx
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
```

**Step 3: Update Card onClick**

Find the Card component (around line 370-376) and update:
```tsx
<Card
  key={expense.id}
  className="squircle hover:bg-accent/50 transition-colors cursor-pointer"
  onClick={() => handleExpenseClick(expense)}
>
```

Remove the old onClick that went to project page.

**Step 4: Add modal to JSX**

Add after the ExpenseDialog component (around line 504):
```tsx
<ExpenseDetailModal
  orgId={orgId}
  currentUserId="" // We'll fix this in next task
  expense={detailExpense}
  open={detailModalOpen}
  onOpenChange={handleDetailModalClose}
  onUpdate={fetchExpenses}
/>
```

**Step 5: Commit**

```bash
git add app/(app)/expenses/expenses-content.tsx
git commit -m "feat(expenses): integrate detail modal into expenses page"
```

---

## Task 7: Pass currentUserId to ExpensesContent

**Files:**
- Modify: `app/(app)/expenses/page.tsx`
- Modify: `app/(app)/expenses/expenses-content.tsx`

**Step 1: Read current page.tsx**

Read the file to understand current structure.

**Step 2: Update page.tsx to pass currentUserId**

The page already gets orgData from getCurrentOrg(). We need to also get the current user ID. Add it to props passed to ExpensesContent:

```tsx
import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { ExpensesContent } from "./expenses-content";

export default async function ExpensesPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
        <p className="text-muted-foreground">
          Track project costs and overhead expenses
        </p>
      </div>

      <ExpensesContent
        orgId={orgData.organization.id}
        currentUserId={orgData.member.userId}
      />
    </div>
  );
}
```

**Step 3: Update ExpensesContent props**

Update the type and add prop:
```tsx
type ExpensesContentProps = {
  orgId: string;
  currentUserId: string;
};

export function ExpensesContent({ orgId, currentUserId }: ExpensesContentProps) {
```

**Step 4: Pass currentUserId to modal**

Update the modal usage to use the real currentUserId:
```tsx
<ExpenseDetailModal
  orgId={orgId}
  currentUserId={currentUserId}
  expense={detailExpense}
  open={detailModalOpen}
  onOpenChange={handleDetailModalClose}
  onUpdate={fetchExpenses}
/>
```

**Step 5: Commit**

```bash
git add app/(app)/expenses/page.tsx app/(app)/expenses/expenses-content.tsx
git commit -m "feat(expenses): pass currentUserId through to detail modal"
```

---

## Task 8: Test the Integration

**Step 1: Run dev server**

Run: `pnpm dev`
Expected: Server starts without errors

**Step 2: Test modal opens**

Navigate to `/expenses`, click any expense row.
Expected: Modal opens with expense details on left, comments on right

**Step 3: Test edit mode**

Click "Edit" button in view mode.
Expected: Form appears with current expense data

**Step 4: Test save**

Change description, click "Save Changes".
Expected: Toast shows "Expense updated", modal returns to view mode with updated data

**Step 5: Test cancel**

Click "Edit", make changes, click "Cancel".
Expected: Returns to view mode with original data (unsaved)

**Step 6: Test comments**

Add a comment in the right panel.
Expected: Comment appears, toast confirms

**Step 7: Commit if tests pass**

```bash
git add -A
git commit -m "test: verify expense detail modal integration"
```

---

## Summary

This plan implements:
1. Updated Expense type with vendor/status
2. ExpenseDetailView - compact view mode
3. ExpenseDetailEdit - full edit form
4. ExpenseDetailModal - two-column modal wrapper
5. Integration into ExpensesContent
6. currentUserId prop threading

Row-level inline controls (Task 2 of design) will be implemented in a follow-up plan after verifying this modal flow works correctly.
