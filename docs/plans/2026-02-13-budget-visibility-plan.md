# Budget Visibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface project budget status across the app — project list, project dashboard, project detail modal, and popovers — so users see budget health where they work, not just in Reports.

**Architecture:** Create a shared `<BudgetBar />` component with two rendering modes (bar and dot). Add a `?includeBudgetUsage=true` query param to the projects list API that aggregates total minutes per project in a single query. Wire `BudgetBar` into the project list, the project dashboard stats card, the project detail view, and project selector popovers. Use CSS container queries so the bar degrades to a dot in compact spaces.

**Tech Stack:** React, Tailwind CSS, Radix UI Progress primitive, CSS container queries, Drizzle ORM

---

### Task 1: Create `<BudgetBar />` component

**Files:**
- Create: `components/ui/budget-bar.tsx`

**Step 1: Create the BudgetBar component**

This component renders in two modes: `bar` (thin progress bar with text) and `dot` (colored circle with tooltip). It accepts budget data and computes status internally.

```tsx
"use client";

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatHoursHuman } from "@/lib/formatting";

type BudgetBarProps = {
  budgetType: "hours" | "fixed";
  /** Total budget (hours for hours type, cents for fixed type) */
  budgetValue: number;
  /** Used amount (hours for hours type, cents for fixed type) */
  usedValue: number;
  /** "bar" = progress bar + text, "dot" = colored circle + tooltip */
  mode?: "bar" | "dot";
  className?: string;
};

function getBudgetStatus(pct: number) {
  if (pct >= 100) return "over" as const;
  if (pct >= 80) return "at_risk" as const;
  return "on_budget" as const;
}

const STATUS_COLORS = {
  over: "bg-red-500",
  at_risk: "bg-amber-500",
  on_budget: "bg-primary",
} as const;

const DOT_COLORS = {
  over: "bg-red-500",
  at_risk: "bg-amber-500",
  on_budget: "bg-emerald-500",
} as const;

function formatBudgetLabel(
  budgetType: "hours" | "fixed",
  usedValue: number,
  budgetValue: number
) {
  if (budgetType === "hours") {
    return `${formatHoursHuman(usedValue * 60)} / ${formatHoursHuman(budgetValue * 60)}`;
  }
  const fmt = (cents: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  return `${fmt(usedValue)} / ${fmt(budgetValue)}`;
}

function BudgetBar({
  budgetType,
  budgetValue,
  usedValue,
  mode = "bar",
  className,
}: BudgetBarProps) {
  const pct = budgetValue > 0 ? (usedValue / budgetValue) * 100 : 0;
  const status = getBudgetStatus(pct);
  const label = formatBudgetLabel(budgetType, usedValue, budgetValue);

  if (mode === "dot") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "size-2 shrink-0 rounded-full",
              DOT_COLORS[status],
              className
            )}
          />
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">{label} ({Math.round(pct)}%)</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>{Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            STATUS_COLORS[status]
          )}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}

export { BudgetBar };
export { getBudgetStatus, formatBudgetLabel };
export type { BudgetBarProps };
```

**Step 2: Verify no build errors**

Run: `pnpm typecheck`
Expected: PASS (no errors related to budget-bar)

**Step 3: Commit**

```bash
git add components/ui/budget-bar.tsx
git commit -m "feat: add BudgetBar component with bar and dot modes"
```

---

### Task 2: Add budget usage data to projects list API

**Files:**
- Modify: `app/api/v1/organizations/[orgId]/projects/route.ts` (GET handler)

The project list API already returns `budgetType`, `budgetHours`, and `budgetAmountCents`. What's missing is the **used** amount. Add an optional `?includeBudgetUsage=true` param that aggregates time entries per project in a single query and includes `totalMinutes` in the response.

**Step 1: Add budget usage aggregation to GET handler**

After the existing project query (line ~81), add a conditional block:

```typescript
// After: const result = ... (line 87)

// Optionally include budget usage data
const includeBudgetUsage = searchParams.get("includeBudgetUsage") === "true";

if (includeBudgetUsage && result.length > 0) {
  const projectIds = result.map((p) => p.id);

  const timeTotals = await db
    .select({
      projectId: timeEntries.projectId,
      totalMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}), 0)`,
    })
    .from(timeEntries)
    .where(inArray(timeEntries.projectId, projectIds))
    .groupBy(timeEntries.projectId);

  const minutesByProject = new Map<string, number>();
  for (const row of timeTotals) {
    if (row.projectId) {
      minutesByProject.set(row.projectId, Number(row.totalMinutes));
    }
  }

  const enrichedResult = result.map((p) => ({
    ...p,
    totalMinutes: minutesByProject.get(p.id) ?? 0,
  }));

  return NextResponse.json(enrichedResult);
}

return NextResponse.json(result);
```

Add the required imports at the top of the file: `timeEntries` from schema, `sql` and `inArray` from drizzle-orm.

Note: `sql` is not currently imported in this file. `inArray` is not currently imported either. Add them to the existing `from "drizzle-orm"` import.

**Step 2: Verify no build errors**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/api/v1/organizations/[orgId]/projects/route.ts
git commit -m "feat: add includeBudgetUsage param to projects list API"
```

---

### Task 3: Add BudgetBar to project list view

**Files:**
- Modify: `app/(app)/projects/projects-content.tsx`

**Step 1: Fetch budget usage data**

Update the `fetchProjects` function to pass `includeBudgetUsage=true`:

```typescript
params.set("includeBudgetUsage", "true");
```

Extend the `Project` type (or the local state) to include `totalMinutes?: number`.

**Step 2: Add BudgetBar to ProjectRow (list view)**

In the `ProjectRow` component, after the rate/billable badges area and before the edit button, add a `BudgetBar` for projects that have a budget:

```tsx
{/* Budget indicator */}
{project.budgetType && (project.budgetHours || project.budgetAmountCents) && (
  <div className="w-28 shrink-0">
    <BudgetBar
      budgetType={project.budgetType}
      budgetValue={project.budgetType === "hours"
        ? (project.budgetHours ?? 0)
        : (project.budgetAmountCents ?? 0)}
      usedValue={project.budgetType === "hours"
        ? ((project as any).totalMinutes ?? 0) / 60
        : ((project as any).totalMinutes ?? 0) / 60 * (project.rateOverride ?? 0) / 100}
    />
  </div>
)}
```

Note: The rate calculation for fixed budgets is approximate here — it uses the project's own rate override. For projects inheriting rates, the display may be slightly off, but this is acceptable for a list-level indicator. The project dashboard has the precise calculation.

**Step 3: Add BudgetBar to table view**

Add a "Budget" column header and corresponding cell to the table view. The cell renders `BudgetBar` for projects with budgets, nothing for others.

**Step 4: Verify no build errors**

Run: `pnpm typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add app/(app)/projects/projects-content.tsx
git commit -m "feat: show budget progress bar in project list and table views"
```

---

### Task 4: Replace inline budget card on project dashboard with BudgetBar

**Files:**
- Modify: `app/(app)/projects/[id]/project-dashboard.tsx`

**Step 1: Replace the budget stats card**

The existing budget card (lines 525-576) uses inline progress bar markup. Replace the bar portion with the `BudgetBar` component for consistency, but keep the card structure (header, big number, remaining text).

The card already calculates `used`, `pct`, and `barColor` — replace the `<div className="h-2 ...">` block with:

```tsx
<BudgetBar
  budgetType={isFixed ? "fixed" : "hours"}
  budgetValue={isFixed ? (stats.budgetAmount ?? 0) : (stats.budgetMinutes ?? 0) / 60}
  usedValue={isFixed ? (stats.budgetUsedAmount ?? 0) : used / 60}
/>
```

Keep the big number display above the bar — it's the card headline.

**Step 2: Add burn rate context below the bar**

Below the BudgetBar, add a burn rate line. Calculate average weekly hours from `stats.totalMinutesAllTime` and the project's age (difference between now and `project.createdAt`):

```tsx
{/* Burn rate context */}
{(() => {
  const weeksActive = Math.max(1,
    Math.floor((Date.now() - new Date(project.createdAt).getTime()) / (7 * 24 * 60 * 60 * 1000))
  );
  const avgMinutesPerWeek = stats.totalMinutesAllTime / weeksActive;
  const remainingMinutes = stats.budgetRemaining ?? 0;
  const weeksRemaining = avgMinutesPerWeek > 0
    ? Math.round(remainingMinutes / avgMinutesPerWeek)
    : null;

  return (
    <p className="text-xs text-muted-foreground mt-2">
      Avg {formatHoursHuman(Math.round(avgMinutesPerWeek))}/week
      {weeksRemaining !== null && remainingMinutes > 0 && (
        <> — ~{weeksRemaining} {weeksRemaining === 1 ? "week" : "weeks"} remaining</>
      )}
    </p>
  );
})()}
```

**Step 3: Add "View detailed breakdown" link**

Below the burn rate, add a link to the Reports tab filtered to this project:

```tsx
<Link
  href={`/reports?tab=projects&projectId=${project.id}`}
  className="text-xs text-primary hover:underline mt-1 inline-block"
>
  View detailed breakdown
</Link>
```

**Step 4: Verify no build errors**

Run: `pnpm typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add app/(app)/projects/[id]/project-dashboard.tsx
git commit -m "feat: use BudgetBar on project dashboard with burn rate context"
```

---

### Task 5: Add BudgetBar to project detail view (modal)

**Files:**
- Modify: `components/projects/project-detail-view.tsx`

**Step 1: Add budget section to project detail view**

After the "Billable" `DetailField` (line 68) and before the archive warning (line 71), add a budget section:

```tsx
{/* Budget */}
{project.budgetType && (project.budgetHours || project.budgetAmountCents) && (
  <DetailField label="Budget">
    <BudgetBar
      budgetType={project.budgetType}
      budgetValue={project.budgetType === "hours"
        ? (project.budgetHours ?? 0)
        : (project.budgetAmountCents ?? 0)}
      usedValue={project.budgetType === "hours"
        ? (budgetUsage?.usedHours ?? 0)
        : (budgetUsage?.usedCents ?? 0)}
    />
  </DetailField>
)}
```

This requires passing budget usage data into `ProjectDetailView`. The parent `ProjectDialog` already fetches project stats — thread the relevant budget data through.

**Step 2: Thread budget usage from ProjectDialog**

Check how `ProjectDialog` works — it may need to fetch stats for the project and pass `budgetUsage` down to `ProjectDetailView`. The simplest approach: add an optional `budgetUsage` prop to `ProjectDetailView`, and in `ProjectDialog`, fetch `/projects/[id]/stats` on open and pass the data.

Add to `ProjectDetailViewProps`:

```typescript
budgetUsage?: {
  usedHours: number;
  usedCents: number;
} | null;
```

In `ProjectDialog`, add a `useEffect` that fetches stats when the dialog opens with an existing project:

```typescript
const [budgetUsage, setBudgetUsage] = useState<{ usedHours: number; usedCents: number } | null>(null);

useEffect(() => {
  if (!open || !project) return;
  if (!project.budgetType) return;

  async function fetchBudgetUsage() {
    const res = await fetch(`/api/v1/organizations/${orgId}/projects/${project!.id}/stats`);
    if (res.ok) {
      const data = await res.json();
      setBudgetUsage({
        usedHours: (data.totalMinutesAllTime ?? 0) / 60,
        usedCents: data.budgetUsedAmount ?? 0,
      });
    }
  }
  fetchBudgetUsage();
}, [open, project, orgId]);
```

Pass `budgetUsage` to `ProjectDetailView`.

**Step 3: Verify no build errors**

Run: `pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add components/projects/project-detail-view.tsx components/projects/project-dialog.tsx
git commit -m "feat: show budget progress in project detail modal"
```

---

### Task 6: Add BudgetBar to project selector popover (nice-to-have)

**Files:**
- Modify: `components/timeline/hierarchy-selector.tsx` or `components/timeline/task-selector.tsx`

This is the "budget context while selecting a project" feature. The selector shows Client > Project > Task hierarchy in a Command popover. Adding a tiny BudgetBar under the project name in the dropdown gives ambient budget awareness while picking where to log time.

**Step 1: Determine data availability**

The hierarchy selector likely fetches projects with their basic data. Budget fields (`budgetType`, `budgetHours`, `budgetAmountCents`) are on the project model. The missing piece is `totalMinutes` — we'd need to either:
- Pre-fetch it alongside the hierarchy data
- Use the `includeBudgetUsage=true` param if the selector uses the projects API

Check the data source for the selector and add budget usage if feasible. If the selector fetches from a different endpoint (like a combined hierarchy endpoint), this may require a separate approach.

**Step 2: Add BudgetBar in dot mode to project items**

In the CommandItem for each project, after the project name, add:

```tsx
{project.budgetType && (
  <BudgetBar
    mode="dot"
    budgetType={project.budgetType}
    budgetValue={...}
    usedValue={...}
    className="ml-1"
  />
)}
```

This is a low-priority enhancement. If the data isn't readily available, skip and note as future work.

**Step 3: Verify no build errors**

Run: `pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add components/timeline/hierarchy-selector.tsx
git commit -m "feat: show budget dot indicator in project selector"
```

---

### Task 7: Add container query support for responsive BudgetBar

**Files:**
- Modify: `components/ui/budget-bar.tsx`
- Modify: `app/(app)/projects/projects-content.tsx` (wrap project rows in container)

**Step 1: Add container query classes to BudgetBar**

Update BudgetBar to auto-switch between bar and dot modes using container queries. The parent container defines `@container`, and BudgetBar uses `@container` responsive classes:

In the parent (ProjectRow or card wrapper), add:

```tsx
<div className="@container">
  {/* ... existing row content ... */}
  <BudgetBar ... mode="auto" />
</div>
```

In BudgetBar, add a `mode="auto"` option that renders both modes with container query visibility:

```tsx
if (mode === "auto") {
  return (
    <>
      {/* Bar mode — visible when container >= 200px */}
      <div className="hidden @[200px]:block">
        <BudgetBar {...props} mode="bar" />
      </div>
      {/* Dot mode — visible when container < 200px */}
      <div className="block @[200px]:hidden">
        <BudgetBar {...props} mode="dot" />
      </div>
    </>
  );
}
```

Note: Tailwind CSS v4 supports container queries with `@container` and `@[size]:` syntax natively. Verify the project's Tailwind config supports this (it should — the codebase already uses `@container/card-header` in `card.tsx`).

**Step 2: Verify responsive behavior**

Manually test by resizing the browser — the bar should degrade to a dot on narrow viewports.

**Step 3: Commit**

```bash
git add components/ui/budget-bar.tsx app/(app)/projects/projects-content.tsx
git commit -m "feat: add container query auto mode to BudgetBar"
```

---

### Task 8: Final verification and cleanup

**Step 1: Run full type check**

Run: `pnpm typecheck`
Expected: PASS

**Step 2: Run lint**

Run: `pnpm lint`
Expected: PASS (or only pre-existing warnings)

**Step 3: Manual smoke test**

- Visit `/projects` — projects with budgets show progress bars, projects without show nothing
- Click into a project with a budget — dashboard card shows BudgetBar with burn rate
- Open project edit dialog → view mode — budget field shows progress bar
- Resize browser narrow — bars degrade to dots on the project list

**Step 4: Commit any cleanup**

```bash
git add -A
git commit -m "chore: budget visibility cleanup and verification"
```
