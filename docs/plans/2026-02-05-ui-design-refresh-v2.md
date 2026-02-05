# UI Design Refresh Implementation Plan v2

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace generic shadcn aesthetics with quieter, intentional structure: sections over card stacks, rings over borders, consistent button styling, and radius discipline.

**Architecture:** Keep structure but make it calmer. Replace `Card` wrappers on list items with `bg-card/30` surfaces and `ring-1 ring-border/40`. Normalize all buttons to a single height/radius. Remove `squircle` from most places, reserving it for hero surfaces only.

**Tech Stack:** Next.js, Tailwind CSS, shadcn/ui (modified defaults)

---

### Task 1: Reduce Card Component Padding and Remove Shadow

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

### Task 2: Normalize Button Styling (Single Height, Radius, Custom Hover)

**Files:**
- Modify: `components/ui/button.tsx`

**Step 1: Read current button component**

Read file to understand current variants.

**Step 2: Edit Button default styling**

Add consistent sizing to the base button class. Modify the base button definition:

From (around line 14-17):
```tsx
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ...",
```

Keep rounded-md but add height standardization. The key changes are in the default state:

Change the `size` variant (around line 28-32) from:
```tsx
size: {
  default: "h-9 px-4 py-2",
  sm: "h-8 rounded-md px-3 text-xs",
  lg: "h-10 rounded-md px-8",
  icon: "h-9 w-9",
},
```

To:
```tsx
size: {
  default: "h-9 px-3 rounded-md",
  sm: "h-8 rounded-md px-2.5 text-xs",
  lg: "h-10 rounded-md px-4",
  icon: "h-9 w-9 rounded-md",
},
```

**Step 3: Verify changes**

Run: `pnpm typecheck`
Expected: No errors

**Step 4: Commit**

```bash
git add components/ui/button.tsx
git commit -m "refactor(button): normalize size/radius, standardize to h-9 rounded-md"
```

---

### Task 3: Refactor Expenses List from Card Items to Borderless Rows with Quiet Surface

**Files:**
- Modify: `app/(app)/expenses/expenses-content.tsx`

**Step 1: Remove Card import and add List interface**

Remove lines 7-11 (Card and CardContent imports) and replace with a simple list interface:

```tsx
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
        "group flex items-center gap-4 px-3 py-3 hover:bg-card/30 transition-colors cursor-pointer",
        !isLast && "border-b border-border/40",
        className
      )}
    >
      {children}
    </div>
  );
}
```

**Step 2: Simplify empty state**

Replace lines 335-349 (the Card-wrapped empty state) with:

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

**Step 3: Replace Card items with ListRow**

Replace lines 351-478 (the space-y-2 container with Card items) with:

```tsx
<div className="rounded-xl bg-card/30 ring-1 ring-border/40">
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
      </ListRow>
    );
  })}
</div>
```

**Step 4: Remove Card import since it's no longer used**

Remove lines 7-11 (Card and CardContent imports) and replace with the ListRow interface (as shown in Step 1 above).

**Step 5: Add cn helper import check**

The file already imports `cn` from `@/lib/utils` at line 39. No change needed.

**Step 6: Remove squircle from filter SelectTriggers**

Find lines 213, 226, 240, 262, 276 and remove `squircle` class from each SelectTrigger:

```tsx
<SelectTrigger className="w-[150px]">
<SelectTrigger className="w-[160px]">
// etc
```

**Step 7: Remove squircle from buttons**

Find lines 310 and 315, remove `squircle` from both Button classNames:

```tsx
<Button variant="outline" onClick={handleExport}>
<Button onClick={() => setDialogOpen(true)}>
```

**Step 8: Verify changes**

Run: `pnpm typecheck`
Expected: No errors

**Step 9: Test the UI**

Run: `pnpm dev`
Navigate to: http://localhost:3000/expenses
Verify:
- List sits in `rounded-xl bg-card/30 ring-1 ring-border/40` container
- Items show as borderless rows with `hover:bg-card/30` state
- Empty state has no card wrapper
- Action buttons in dropdown only visible on row hover (via `group-hover:opacity-100`)
- Filter triggers have no squircle class

**Step 10: Commit**

```bash
git add app/(app)/expenses/expenses-content.tsx
git commit -m "refactor(expenses): replace card-wrapped list items with borderless rows in section container

- Add section wrapper with bg-card/30 and ring-1 ring-border/40
- Add ListRow pattern with hover-based action visibility
- Simplify empty state (no card wrapper)
- Remove squircle class from filters and buttons
- Use hover:bg-card/30 for subtle hover surfaces
- Group-hover pattern for hidden-until-hover actions"
```

---

### Task 4: Fix Page Header Spacing (Expenses)

**Files:**
- Modify: `app/(app)/expenses/page.tsx`

**Step 1: Read current file**

Read the full file to see header structure (likely lines 25-40).

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

## Follow-Up Work (Out of Scope for This Plan)

The following pages/components need similar treatment but are NOT included in this plan to keep scope focused:

1. `app/(app)/projects/projects-content.tsx` — Card-wrapped project rows (lines ~475-554)
2. `app/(app)/clients/clients-content.tsx` — Card-wrapped client rows (lines ~479-522)
3. `app/(app)/invoices/invoices-content.tsx` — Card-wrapped invoice rows (lines ~313-360)
4. `app/(app)/contracts/contracts-content.tsx` — Contract list items
5. `app/(app)/proposals/proposals-content.tsx` — Proposal list items
6. Individual page headers in `app/(app)/{projects,clients,invoices,contracts,proposals}/page.tsx`

Apply the same patterns from Tasks 2-4 to these files to complete the visual refresh across the app.

---

## Verification Checklist

After all tasks complete, verify:

1. [ ] Expenses list sits in section container with `rounded-xl bg-card/30 ring-1 ring-border/40`
2. [ ] List items show as borderless rows with `hover:bg-card/30` state
3. [ ] Empty state has no card wrapper, centered content with icon
4. [ ] Page header has `mb-8` spacing and `text-xl` title
5. [ ] All components pass TypeScript check
6. [ ] Dropdown menu actions only visible on row hover (opacity-0 → group-hover:opacity-100)
7. [ ] Card padding reduced (p-5 instead of py-6)
8. [ ] Buttons use consistent h-9 rounded-md sizing
