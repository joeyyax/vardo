# UI Design Refresh Implementation Plan v3 (Squircle Baseline)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep shadcn/ui, but remove the "kit" feel by introducing quieter structure: sections over card stacks, rings over borders, consistent button styling, and hierarchy via surface/density/contrast.

**Geometry policy (IMPORTANT):** Squircles replace border-radius across the system. Do not remove squircles globally. Do not mix standard rounded corners with squircles, except where a true pill shape is required (chips/toggles).

**Hierarchy should come from:** fewer containers, calmer surfaces, consistent spacing, and hover contrast — not corner changes.

**Tech Stack:** Next.js, Tailwind CSS, shadcn/ui (modified defaults)

---

### Task 0: Update the Design Rules Baked Into Implementation (Critical Correction)

Replace this statement (from v2):

> "Remove squircle from most places, reserving it for hero surfaces only."

With:

> "Keep squircle as the default geometry system-wide. Reduce container weight (borders/shadows/card wrappers), not curvature. Only use standard radius where a pill is required."

No code changes. This is a directive so future tasks don't drift.

---

### Task 1: Reduce Card Component Weight (Padding + Shadow) Without Changing Geometry

**Files:**
- Modify: `components/ui/card.tsx`

**Step 1: Edit Card default styling**

Change line 10 from:
```tsx
"bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm",
```

To:
```tsx
"bg-card text-card-foreground flex flex-col gap-5 border p-5",
```

Notes:
- If rounded-xl is a squircle class elsewhere, keep it consistent with your squircle system (don't swap to rounded-lg here).
- The goal is calmer weight (no shadow-sm), not a different corner language.

**Step 2: Verify**

Run: `pnpm typecheck`

**Step 3: Commit**

```bash
git add components/ui/card.tsx
git commit -m "refactor(card): reduce padding and remove shadow to calm surfaces"
```

---

### Task 2: Normalize Button Styling (Single Height + Custom Hover) While Preserving Squircle Geometry

**Files:**
- Modify: `components/ui/button.tsx`

**Step 1: Read current button component**

Read the file to understand current variants.

**Step 2: Edit Button default styling**

Keep your squircle treatment (if applied globally), but normalize sizing so buttons don't feel "default shadcn."

Update the size variants to remove excess padding differences and normalize density:

```tsx
size: {
  default: "h-9 px-3",
  sm: "h-8 px-2.5 text-xs",
  lg: "h-10 px-4",
  icon: "h-9 w-9",
},
```

Optional (recommended): add a subtle, consistent hover treatment to the base class (not per page):
- Prefer quiet hover + active states
- Avoid heavy borders

**Step 3: Verify**

Run: `pnpm typecheck`

**Step 4: Commit**

```bash
git add components/ui/button.tsx
git commit -m "refactor(button): normalize sizing and hover for calmer, consistent buttons"
```

---

### Task 3: Refactor Expenses List From Card Items to "Section Container + Quiet Rows" (No Corner Refactor)

**Files:**
- Modify: `app/(app)/expenses/expenses-content.tsx`

**Step 1: Remove Card-wrapped rows, keep squircle baseline**

Do not add "rounded-lg" style classes that fight your squircle system.

The goal is:
- One section container surface
- Light ring
- Rows are dense, simple, hover-based

**Section wrapper** (keep as-is from v2, this is good):

```tsx
<div className="bg-card/30 ring-1 ring-border/40">
```

**Step 2: ListRow helper**

Keep the ListRow approach, but adjust hover so it doesn't "double-surface" inside the same bg:
- Wrapper already has bg-card/30
- Row hover should be slightly stronger, but still subtle

Example:
```tsx
"hover:bg-card/40 transition-colors"
```

And keep the divider:
```tsx
!isLast && "border-b border-border/40"
```

**Step 3: Empty state**

Your empty state replacement from v2 is solid. Keep it:

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

**Step 4: Do NOT remove squircle classes by default**

Replace v2 Steps 6-7 ("remove squircle from triggers/buttons") with:

**New Step 6:** Only remove squircle where it causes a pill conflict
- If a component needs a true pill: keep standard `rounded-full` there.
- Otherwise, leave squircle alone.

**New Step 7:** Verify filter controls match the geometry system
- Ensure SelectTrigger / buttons follow the same geometry system
- Do not mix `rounded-*` utilities unless it's a pill

**Step 8: Implement the full ListRow refactor**

Replace lines 351-478 (the space-y-2 container with Card items) with:

```tsx
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

**Step 9: Add ListRow component and update imports**

Remove lines 7-11 (Card and CardContent imports) and add the ListRow component after the imports:

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
        "group flex items-center gap-4 px-3 py-3 hover:bg-card/40 transition-colors cursor-pointer",
        !isLast && "border-b border-border/40",
        className
      )}
    >
      {children}
    </div>
  );
}
```

**Step 10: Verify**

Run: `pnpm typecheck`
Run: `pnpm dev`
Navigate to: http://localhost:3000/expenses

Expected:
- One calm section surface (bg-card/30 + ring-1)
- Rows are simple and dense (not Card stacks)
- Hover indicates interactivity (no extra borders/shadows)
- Dropdown actions only appear on hover

**Step 11: Commit**

```bash
git add app/(app)/expenses/expenses-content.tsx
git commit -m "refactor(expenses): replace card stacks with section container + quiet rows

- Use a single section surface (bg-card/30 + ring) instead of per-row cards
- Introduce ListRow pattern with subtle hover and simple dividers
- Simplify empty state
- Preserve squircle geometry system (no global removal)"
```

---

### Task 4: Tighten Page Header (Expenses)

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

**Step 3: Verify**

Run: `pnpm typecheck`

**Step 4: Commit**

```bash
git add app/(app)/expenses/page.tsx
git commit -m "refactor(expenses): tighten page header spacing and reduce title size"
```

---

## Follow-Up Work (Out of Scope for This Plan)

The following pages/components need similar treatment but are NOT included in this plan to keep scope focused:

1. `app/(app)/projects/projects-content.tsx` — Card-wrapped project rows
2. `app/(app)/clients/clients-content.tsx` — Card-wrapped client rows
3. `app/(app)/invoices/invoices-content.tsx` — Card-wrapped invoice rows
4. `app/(app)/contracts/contracts-content.tsx` — Contract list items
5. `app/(app)/proposals/proposals-content.tsx` — Proposal list items
6. Individual page headers in `app/(app)/{projects,clients,invoices,contracts,proposals}/page.tsx`

Apply the same patterns from Tasks 2-4 to these files to complete the visual refresh across the app.

---

## Verification Checklist (Updated for Squircle Baseline)

- [ ] Expenses list uses one section container surface (bg-card/30 ring-1 ring-border/40)
- [ ] Rows are not Card-wrapped; they use a quiet hover and simple dividers
- [ ] Empty state is not Card-wrapped
- [ ] Header is mb-8 with text-xl font-semibold tracking-tight
- [ ] Buttons are normalized (consistent height) and feel less "default shadcn"
- [ ] Squircle geometry is preserved system-wide (no mixed rounded corners except pills)
- [ ] pnpm typecheck passes
