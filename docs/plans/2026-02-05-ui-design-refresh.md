# UI Design Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move away from generic shadcn aesthetics by reducing card/container overuse, simplifying typography, and creating calm, spacious UI with intentional borders and spacing.

**Architecture:** Reduce Card component padding/elevation, replace Card-wrapped list items with borderless hoverable rows, consolidate page headers, and apply consistent spacing rules across data views.

**Tech Stack:** Next.js, Tailwind CSS, shadcn/ui (modified defaults)

---

### Task 1: Reduce Card Component Padding and Elevation

**Files:**
- Modify: `components/ui/card.tsx`

**Step 1: Edit Card default styling**

Change line 10 from:
```tsx
"bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm",
```

To:
```tsx
"bg-card text-card-foreground flex flex-col gap-5 rounded-lg border p-5",
```

**Step 2: Verify changes**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add components/ui/card.tsx
git commit -m "refactor(card): reduce padding and remove shadow for calmer surfaces"
```

---

### Task 2: Simplify Table Row Borders

**Files:**
- Modify: `components/ui/table.tsx`

**Step 1: Edit TableHeader styling**

Change line 26 from:
```tsx
className={cn("[&_tr]:border-b", className)}
```

To:
```tsx
className={cn("[&_tr]:border-b [&_tr]:border-border/50", className)}
```

**Step 2: Edit TableRow styling**

Change line 60 from:
```tsx
"hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors",
```

To:
```tsx
"hover:bg-accent/20 data-[state=selected]:bg-muted border-b border-border/50 transition-colors",
```

**Step 3: Verify changes**

Run: `pnpm typecheck`
Expected: No errors

**Step 4: Commit**

```bash
git add components/ui/table.tsx
git commit -m "refactor(table): soften borders and use accent for hover state"
```

---

### Task 3: Refactor Expenses List from Card Items to Borderless Rows

**Files:**
- Modify: `app/(app)/expenses/expenses-content.tsx`

**Step 1: Add ListRow component at top of file**

After the imports (around line 43), add:

```tsx
// Borderless list row component
function ListRow({
  children,
  onClick,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "group flex items-center gap-4 px-3 py-3 hover:bg-accent/20 transition-colors cursor-pointer border-b border-border/50 last:border-b-0",
        className
      )}
    >
      {children}
    </div>
  );
}
```

**Step 2: Simplify empty state**

Replace lines 335-349 (the `<Card className="squircle">` with empty state) with:

```tsx
<div className="py-12 text-center">
  <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
    <Receipt className="size-6 text-muted-foreground" />
  </div>
  <h3 className="mt-4 text-lg font-medium">No expenses yet</h3>
  <p className="mt-2 text-sm text-muted-foreground">
    Track project costs and overhead expenses.
  </p>
  <Button onClick={() => setDialogOpen(true)} className="mt-4">
    <Plus className="size-4" />
    Add Expense
  </Button>
</div>
```

**Step 3: Replace Card-wrapped expense items**

Replace lines 351-478 (the `space-y-2` container and Card map) with:

```tsx
<div className="divide-y divide-border/50">
  {expenses.map((expense, index) => {
    const isOverhead = !expense.project;
    const isLast = index === expenses.length - 1;

    return (
      <div
        key={expense.id}
        onClick={() => handleExpenseClick(expense)}
        className="group flex items-center gap-4 px-3 py-3 hover:bg-accent/20 transition-colors cursor-pointer"
      >
        {/* Left indicator */}
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
            <DropdownMenuContent align="end">
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
      </div>
    );
  })}
</div>
```

**Step 4: Remove Card import since it's no longer used**

Remove lines 7-11:
```tsx
import {
  Card,
  CardContent,
} from "@/components/ui/card";
```

**Step 5: Change filter area spacing**

Keep the filter area but remove squircle from filter SelectTriggers. Change lines 213, 226, 240, 262, 276 - remove `className="squircle"` from each SelectTrigger:

```tsx
<SelectTrigger className="w-[150px]">
// etc
```

**Step 6: Remove squircle from buttons**

Change line 310-317 - remove `className="squircle"` from both buttons.

**Step 7: Verify changes**

Run: `pnpm typecheck`
Expected: No errors

**Step 8: Test the UI**

Run: `pnpm dev`
Navigate to: http://localhost:3000/expenses
Verify: List items show as borderless rows with hover states, dropdown actions hidden until hover.

**Step 9: Commit**

```bash
git add app/(app)/expenses/expenses-content.tsx
git commit -m "refactor(expenses): replace card-wrapped list items with borderless rows

- Add ListRow pattern with hover-based action visibility
- Simplify empty state (no card wrapper)
- Remove squircle class from filters and buttons
- Use accent/20 for subtle hover states"
```

---

### Task 4: Fix Page Header Spacing

**Files:**
- Modify: `app/(app)/expenses/page.tsx`

**Step 1: Read current file**

Read the full file to see header structure.

**Step 2: Edit page header**

Find the header section and change from:
```tsx
<div className="space-y-6">
  <div>
    <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
    <p className="text-muted-foreground">
      Track expenses across all projects.
    </p>
  </div>
```

To:
```tsx
<div className="mb-8">
  <h1 className="text-xl font-semibold tracking-tight">Expenses</h1>
</div>
```

**Step 3: Verify changes**

Run: `pnpm typecheck`
Expected: No errors

**Step 4: Commit**

```bash
git add app/(app)/expenses/page.tsx
git commit -m "refactor(expenses): tighten page header spacing and reduce title size"
```

---

## Verification Checklist

After all tasks complete, verify:

1. [ ] Expenses list shows borderless rows with hover state
2. [ ] Empty state is minimal (no card container)
3. [ ] Page header has reduced spacing and smaller title
4. [ ] All components pass TypeScript check
5. [ ] Dropdown menu actions only visible on row hover
