# Report Toolbars, Saved Presets & Export Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add PageToolbar with client/project filters to all report tabs, saved report presets (persisted to DB), and CSV + PDF export.

**Architecture:** Three independent phases — (1) move existing filter controls into PageToolbar and add client/project filtering, (2) add a `savedReportPresets` DB table with CRUD API + toolbar dropdown, (3) add export endpoints (CSV via server-side string building, PDF via `@react-pdf/renderer` which is already installed). Filter state is lifted to `ReportsPageContent` and shared across Overview/Accounting tabs. Client Reports has its own local filter state.

**Tech Stack:** Next.js App Router, Drizzle ORM (Postgres), shadcn/ui (Popover + Command for preset picker), `@react-pdf/renderer` for PDF export, existing CSV pattern from `entries/export`.

---

## Phase 1: PageToolbar + Client/Project Filters

### Task 1: Add clientId/projectId filter support to analytics API

**Files:**
- Modify: `app/api/v1/organizations/[orgId]/analytics/route.ts`

**Context:** The analytics endpoint currently accepts `from`, `to`, `period` params. It queries `timeEntries` joined with `clients`, `projects`, `tasks`. It also queries `invoices` and `projectExpenses` for revenue by month. None of these queries filter by clientId or projectId.

**What to do:**
1. Read `clientId` and `projectId` from `url.searchParams`
2. If `clientId` is provided, add `eq(timeEntries.clientId, clientId)` to the entries query `where` clause, `eq(invoices.clientId, clientId)` to the invoices query, and `eq(projectExpenses.clientId, clientId)` to the expenses query
3. If `projectId` is provided, add `eq(timeEntries.projectId, projectId)` to entries, and `eq(projectExpenses.projectId, projectId)` to expenses. Invoices don't have a direct projectId — skip that filter for invoices.
4. The conditions array pattern is already used — just push additional conditions when the params are present

**Verify:** `pnpm typecheck` passes.

---

### Task 2: Add clientId filter support to reports/expenses and reports/invoices APIs

**Files:**
- Modify: `app/api/v1/organizations/[orgId]/reports/expenses/route.ts`
- Modify: `app/api/v1/organizations/[orgId]/reports/invoices/route.ts`
- Modify: `app/api/v1/organizations/[orgId]/reports/projects/route.ts`

**Context:** These three endpoints power the Overview tab sections. They accept `from`/`to` date params but not client/project filters.

**What to do:**
1. In each route, read `clientId` and `projectId` from searchParams
2. **reports/expenses:** Add `eq(projectExpenses.clientId, clientId)` and/or `eq(projectExpenses.projectId, projectId)` to the where conditions when present
3. **reports/invoices:** Add `eq(invoices.clientId, clientId)` to the where conditions when present. Invoices don't have projectId — skip that.
4. **reports/projects:** Add `eq(projects.clientId, clientId)` and/or `eq(projects.id, projectId)` to the where conditions when present

**Verify:** `pnpm typecheck` passes.

---

### Task 3: Lift filter state and add client/project data fetching to ReportsPageContent

**Files:**
- Modify: `app/(app)/reports/reports-page-content.tsx`

**Context:** Currently `ReportsPageContent` manages `period`, `customRange`, and fetches data via 4 parallel API calls. The `AccountingTab` and `ReportConfigs` are self-contained components with their own data fetching. We need to add shared client/project filter state and pass filter params to ALL API calls.

**What to do:**
1. Add state: `const [clientId, setClientId] = useState<string | null>(null)` and `const [projectId, setProjectId] = useState<string | null>(null)`
2. Add state + fetch for clients list: `const [clients, setClients] = useState<{id: string; name: string; color: string | null}[]>([])` — fetch from `/api/v1/organizations/${orgId}/clients` on mount
3. Add state + fetch for projects list: `const [projects, setProjects] = useState<{id: string; name: string; clientId: string}[]>([])` — fetch from `/api/v1/organizations/${orgId}/projects` on mount
4. Compute `filteredProjects` — if `clientId` is set, filter projects to just that client
5. In `buildDateParams`, extend to accept `clientId`/`projectId` and append `&clientId=X&projectId=Y` when present
6. Update the `loadData` `useEffect` to include `clientId` and `projectId` in the dependency array and pass them as query params to all 4 fetch calls
7. Pass `clientId`, `setClientId`, `clients` (and project equivalents) as props down to child components that need them, or use them directly in the Overview tab toolbar
8. When `clientId` changes, reset `projectId` to null (project depends on client)

**Verify:** `pnpm typecheck` passes.

---

### Task 4: Add PageToolbar to Overview tab

**Files:**
- Modify: `app/(app)/reports/reports-page-content.tsx`
- Add import: `PageToolbar` from `@/components/page-toolbar`

**Context:** The Overview tab currently renders `<DateRangePicker>` as a standalone element above the content. We need to wrap it in `<PageToolbar>` and add client/project filter dropdowns.

**What to do:**
1. Import `PageToolbar` from `@/components/page-toolbar`
2. Import `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` from `@/components/ui/select`
3. Replace the standalone `<DateRangePicker>` with:
```tsx
<PageToolbar
  actions={
    <>
      {/* Export button will go here in Phase 3 */}
    </>
  }
>
  <DateRangePicker
    period={period}
    customRange={customRange}
    onPeriodChange={setPeriod}
    onCustomRangeChange={setCustomRange}
  />
  <Select value={clientId || "all"} onValueChange={(v) => { setClientId(v === "all" ? null : v); setProjectId(null); }}>
    <SelectTrigger className="squircle w-[180px]">
      <SelectValue placeholder="All Clients" />
    </SelectTrigger>
    <SelectContent className="squircle">
      <SelectItem value="all">All Clients</SelectItem>
      {clients.map((c) => (
        <SelectItem key={c.id} value={c.id}>
          <div className="flex items-center gap-2">
            {c.color && <div className="size-2.5 rounded-full" style={{ backgroundColor: c.color }} />}
            {c.name}
          </div>
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
  <Select value={projectId || "all"} onValueChange={(v) => setProjectId(v === "all" ? null : v)}>
    <SelectTrigger className="squircle w-[180px]">
      <SelectValue placeholder="All Projects" />
    </SelectTrigger>
    <SelectContent className="squircle">
      <SelectItem value="all">All Projects</SelectItem>
      {filteredProjects.map((p) => (
        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
      ))}
    </SelectContent>
  </Select>
  {(clientId || projectId) && (
    <Button variant="ghost" size="sm" onClick={() => { setClientId(null); setProjectId(null); }}>
      <X className="size-4" /> Clear
    </Button>
  )}
</PageToolbar>
```
4. Import `X` from lucide-react and `Button` from ui/button if not already imported

**Verify:** `pnpm typecheck` passes. Dev server shows toolbar with date range + client + project filters on Overview tab.

---

### Task 5: Add PageToolbar to Accounting tab

**Files:**
- Modify: `components/reports/accounting-tab.tsx`

**Context:** The Accounting tab has its own year selector and manages its own data fetching. It needs a PageToolbar wrapping its year selector, plus a client filter. It receives `orgId` as a prop.

**What to do:**
1. Add props: `clientId: string | null`, `clients: {id: string; name: string; color: string | null}[]`, `onClientChange: (id: string | null) => void`
2. Import `PageToolbar` from `@/components/page-toolbar`
3. Replace the current `<div className="flex items-center gap-4">` year selector wrapper with `<PageToolbar>` containing:
   - The existing year `<Select>` (move it inside PageToolbar children)
   - A client filter `<Select>` (same pattern as Overview)
   - Clear button when client is selected
4. Pass `clientId` as a query param in the 3 fetch calls inside `useEffect` — append `&clientId=${clientId}` to each URL when present
5. Add `clientId` to the `useEffect` dependency array
6. Update the parent `ReportsPageContent` to pass `clientId`, `clients`, and `onClientChange={setClientId}` to `<AccountingTab>`

**Verify:** `pnpm typecheck` passes.

---

### Task 6: Add PageToolbar to Client Reports tab

**Files:**
- Modify: `components/reports/report-configs.tsx`

**Context:** The Client Reports tab manages its own list of report configs. Its toolbar should have search + status filter + view switcher + New Report button. The client/project filter doesn't apply here (it's filtering configs, not time data).

**What to do:**
1. Import `PageToolbar` from `@/components/page-toolbar`
2. Import `Input` from `@/components/ui/input` (already imported)
3. Add state: `const [searchQuery, setSearchQuery] = useState("")` and `const [statusFilter, setStatusFilter] = useState<"all" | "active" | "disabled">("all")`
4. Add `filteredConfigs` computed from `configs` — filter by search query (match against report name) and status filter (enabled/disabled)
5. Replace the current header `<div className="flex items-center justify-between">` with:
```tsx
<PageToolbar
  actions={
    <>
      <ViewSwitcher views={REPORT_VIEWS} value={view} onValueChange={setView} />
      <Button onClick={() => setCreateDialogOpen(true)} className="squircle">
        <Plus className="size-4" />
        New Report
      </Button>
    </>
  }
>
  <Input
    placeholder="Search reports..."
    value={searchQuery}
    onChange={(e) => setSearchQuery(e.target.value)}
    className="squircle w-[200px]"
  />
  <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as "all" | "active" | "disabled")}>
    <SelectTrigger className="squircle w-[130px]">
      <SelectValue />
    </SelectTrigger>
    <SelectContent className="squircle">
      <SelectItem value="all">All Status</SelectItem>
      <SelectItem value="active">Active</SelectItem>
      <SelectItem value="disabled">Disabled</SelectItem>
    </SelectContent>
  </Select>
  {(searchQuery || statusFilter !== "all") && (
    <Button variant="ghost" size="sm" onClick={() => { setSearchQuery(""); setStatusFilter("all"); }}>
      <X className="size-4" /> Clear
    </Button>
  )}
</PageToolbar>
```
6. Remove the old header div (title + description + button layout)
7. Use `filteredConfigs` instead of `configs` in both list and table view rendering
8. Import `X` and `Search` from lucide-react if not already

**Verify:** `pnpm typecheck` passes.

---

## Phase 2: Saved Report Presets

### Task 7: Add savedReportPresets table to schema

**Files:**
- Modify: `lib/db/schema.ts`

**Context:** The schema file uses Drizzle ORM with `pgTable`. Tables reference `organizations` and `users`. The table goes near `reportConfigs` (line ~407). Relations go at the bottom of the file with the other relations definitions.

**What to do:**
1. Add the table after `reportConfigs`:
```ts
export const savedReportPresets = pgTable("saved_report_presets", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tab: text("tab").notNull(), // 'overview' | 'accounting' | 'client-reports'
  filters: jsonb("filters").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```
2. Add relations:
```ts
export const savedReportPresetsRelations = relations(savedReportPresets, ({ one }) => ({
  organization: one(organizations, {
    fields: [savedReportPresets.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [savedReportPresets.userId],
    references: [users.id],
  }),
}));
```
3. Add `savedReportPresets: many(savedReportPresets)` to `organizationsRelations`
4. Run `pnpm db:push` to push the schema change

**Verify:** `pnpm typecheck` passes. `pnpm db:push` succeeds.

---

### Task 8: Create API endpoints for saved report presets

**Files:**
- Create: `app/api/v1/organizations/[orgId]/report-presets/route.ts`
- Create: `app/api/v1/organizations/[orgId]/report-presets/[presetId]/route.ts`

**Context:** Follow the same pattern as other API routes in this directory. Use `requireOrg()` from `@/lib/auth/session` for auth. The org check is `if (organization.id !== orgId) return 403`. User ID comes from `session.user.id`.

**What to do:**

**`route.ts` (list + create):**
```ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { savedReportPresets } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc } from "drizzle-orm";

type RouteParams = { params: Promise<{ orgId: string }> };

// GET — list presets for current user
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { session, organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const presets = await db.query.savedReportPresets.findMany({
      where: and(
        eq(savedReportPresets.organizationId, orgId),
        eq(savedReportPresets.userId, session.user.id)
      ),
      orderBy: [desc(savedReportPresets.createdAt)],
    });

    return NextResponse.json(presets);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST — create a preset
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { session, organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { name, tab, filters } = body;

    if (!name || !tab || !filters) {
      return NextResponse.json({ error: "name, tab, and filters are required" }, { status: 400 });
    }

    const [preset] = await db.insert(savedReportPresets).values({
      organizationId: orgId,
      userId: session.user.id,
      name,
      tab,
      filters,
    }).returning();

    return NextResponse.json(preset, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**`[presetId]/route.ts` (delete):**
```ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { savedReportPresets } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = { params: Promise<{ orgId: string; presetId: string }> };

// DELETE — delete a preset (only if owned by current user)
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, presetId } = await params;
    const { session, organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await db.delete(savedReportPresets).where(
      and(
        eq(savedReportPresets.id, presetId),
        eq(savedReportPresets.organizationId, orgId),
        eq(savedReportPresets.userId, session.user.id)
      )
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Verify:** `pnpm typecheck` passes.

---

### Task 9: Build SavedReportsDropdown component

**Files:**
- Create: `components/reports/saved-reports-dropdown.tsx`

**Context:** Uses the Popover + Command pattern (see `ProjectSelector`, `TaskSelector` for reference). The component manages its own preset list fetching.

**What to do:**
Create a component with these props:
```ts
type SavedReportsDropdownProps = {
  orgId: string;
  currentTab: string; // 'overview' | 'accounting' | 'client-reports'
  currentFilters: Record<string, unknown>;
  onApplyPreset: (filters: Record<string, unknown>) => void;
};
```

Implementation:
1. Fetch presets from `/api/v1/organizations/${orgId}/report-presets` on mount, filter to `currentTab`
2. Render a `<Popover>` trigger button labeled "Saved" (or with a `Bookmark` icon from lucide)
3. Inside `<PopoverContent>`, render a `<Command>` with `shouldFilter={false}`:
   - `<CommandInput>` placeholder "Search saved reports..."
   - `<CommandList>` containing:
     - `<CommandGroup>` with each preset as a `<CommandItem>` — show name, click applies filters via `onApplyPreset(preset.filters)` and closes popover
     - Each item gets a trash icon button (with `e.stopPropagation()`) that calls DELETE and removes from local state
     - Show checkmark on the preset whose filters match `currentFilters` (deep compare)
   - `<CommandSeparator>`
   - `<CommandItem>` at the bottom: "Save current filters..." — opens a small inline input (or dialog) to name the preset, then POSTs to API
4. The save action: when clicked, show an `<Input>` inline in the dropdown. On Enter or a save button, POST to API with `{ name, tab: currentTab, filters: currentFilters }`, add to local state, close
5. Empty state when no presets: just show the "Save current filters..." option
6. Use `toast.success("Preset saved")` and `toast.success("Preset deleted")` for feedback

**Verify:** `pnpm typecheck` passes.

---

### Task 10: Wire SavedReportsDropdown into all three report tabs

**Files:**
- Modify: `app/(app)/reports/reports-page-content.tsx`
- Modify: `components/reports/accounting-tab.tsx`
- Modify: `components/reports/report-configs.tsx`

**Context:** Each tab has a `<PageToolbar>` from Tasks 4-6. The dropdown goes in the `actions` slot of each toolbar.

**What to do:**
1. In `ReportsPageContent`, build `currentFilters` object from state: `{ period, customRange, clientId, projectId }` for Overview tab
2. Add `onApplyPreset` handler that destructures filters and calls the corresponding setters
3. Add `<SavedReportsDropdown>` to the Overview toolbar's `actions`:
```tsx
actions={
  <>
    <SavedReportsDropdown
      orgId={orgId}
      currentTab="overview"
      currentFilters={{ period, clientId, projectId, ...(period === "custom" && customRange ? { customFrom: customRange.from?.toISOString(), customTo: customRange.to?.toISOString() } : {}) }}
      onApplyPreset={(filters) => {
        setPeriod((filters.period as Period) || "month");
        setClientId((filters.clientId as string) || null);
        setProjectId((filters.projectId as string) || null);
        if (filters.customFrom && filters.customTo) {
          setCustomRange({ from: new Date(filters.customFrom as string), to: new Date(filters.customTo as string) });
        } else {
          setCustomRange(undefined);
        }
      }}
    />
  </>
}
```
4. In `AccountingTab`, add `<SavedReportsDropdown>` to toolbar actions with filters `{ year: selectedYear, clientId }`
5. In `ReportConfigs`, add `<SavedReportsDropdown>` to toolbar actions with filters `{ searchQuery, statusFilter }`
6. Each tab's `onApplyPreset` handler maps preset filters back to its state setters

**Verify:** `pnpm typecheck` passes.

---

## Phase 3: Export (CSV + PDF)

### Task 11: Create CSV export endpoint for reports

**Files:**
- Create: `app/api/v1/organizations/[orgId]/reports/export/route.ts`

**Context:** Follow the CSV pattern from `entries/export/route.ts`. Accept `format`, `tab`, and the same filter params as the report APIs (`from`, `to`, `period`, `clientId`, `projectId`).

**What to do:**
1. Accept query params: `format` (csv|pdf), `tab` (overview|accounting), `from`, `to`, `period`, `clientId`, `projectId`
2. For `format=csv`:
   - Compute date range from params (same logic as analytics endpoint)
   - **Overview tab:** Fetch analytics, expenses, invoices, projects data (same 4 API calls the frontend makes, but done server-side via direct DB queries). Build a multi-section CSV:
     - Section: "Financial Summary" — Revenue, Expenses, Profit, Outstanding
     - Section: "Time by Client" — Client, Billable Hours, Unbillable Hours, Amount
     - Section: "Expenses by Category" — Category, Amount
     - Section: "Invoice Status" — Status, Count, Amount
   - **Accounting tab:** Fetch year data. Build CSV with monthly rows: Month, Income, Expenses, Profit
3. Set `Content-Type: text/csv` and `Content-Disposition: attachment; filename="report-{tab}-{daterange}.csv"`
4. Use `requireOrg()` for auth, verify orgId matches
5. If `format=pdf`, return 501 for now (implemented in Task 12)

**Verify:** `pnpm typecheck` passes.

---

### Task 12: Create PDF template for reports

**Files:**
- Create: `lib/reports/pdf-template.tsx`

**Context:** Follow the pattern in `lib/invoices/pdf-template.tsx`. Uses `@react-pdf/renderer` with `Document`, `Page`, `Text`, `View`, `StyleSheet`. No interactive charts — tables and numbers only.

**What to do:**
1. Define `ReportPdfData` type:
```ts
type ReportPdfData = {
  organizationName: string;
  reportTitle: string; // e.g., "Overview Report" or "Accounting Report"
  dateRange: string; // e.g., "Jan 1, 2026 - Jan 31, 2026"
  generatedAt: string;
  financial?: { revenue: number; expenses: number; profit: number; outstanding: number };
  timeByClient?: Array<{ name: string; billableHours: number; unbillableHours: number; amount: number }>;
  expensesByCategory?: Array<{ category: string; amount: number }>;
  invoiceStatus?: { paid: number; pending: number; overdue: number; draft: number };
  accountingMonths?: Array<{ month: string; income: number; expenses: number; profit: number }>;
};
```
2. Create styles (matching the invoice PDF template's font/color scheme)
3. Render sections conditionally based on which data is present:
   - Header: org name, report title, date range, "Generated on {date}"
   - Financial summary as a 4-column row
   - Time by Client as a table
   - Expenses by Category as a table
   - Invoice Status as a summary row
   - Accounting months as a table (for accounting tab)
4. Export both the component and the type

**Verify:** `pnpm typecheck` passes.

---

### Task 13: Create PDF generation utility and wire into export endpoint

**Files:**
- Create: `lib/reports/pdf.ts`
- Modify: `app/api/v1/organizations/[orgId]/reports/export/route.ts`

**Context:** Follow the pattern in `lib/invoices/pdf.ts` which uses `renderToBuffer` from `@react-pdf/renderer`.

**What to do:**
1. In `lib/reports/pdf.ts`:
```ts
import { renderToBuffer } from "@react-pdf/renderer";
import { ReportPdfTemplate, type ReportPdfData } from "./pdf-template";

export async function generateReportPdf(data: ReportPdfData): Promise<Buffer> {
  return renderToBuffer(<ReportPdfTemplate data={data} />);
}
```
2. In the export route, handle `format=pdf`:
   - Fetch the same data as CSV but transform into `ReportPdfData`
   - Call `generateReportPdf(data)`
   - Return with `Content-Type: application/pdf` and `Content-Disposition: attachment; filename="report-{tab}-{daterange}.pdf"`
3. Helper: `formatCurrency(cents)` for converting cents to dollar strings in the PDF data

**Verify:** `pnpm typecheck` passes.

---

### Task 14: Add Export dropdown button to report toolbars

**Files:**
- Create: `components/reports/export-dropdown.tsx`
- Modify: `app/(app)/reports/reports-page-content.tsx`
- Modify: `components/reports/accounting-tab.tsx`

**Context:** A small dropdown with "Download CSV" and "Download PDF" options. Uses `DropdownMenu` from shadcn/ui.

**What to do:**
1. Create `ExportDropdown` component:
```tsx
type ExportDropdownProps = {
  orgId: string;
  tab: string;
  params: Record<string, string | undefined>;
};
```
   - Renders a `<DropdownMenu>` with trigger button (Download icon + "Export" text)
   - Two items: "Download CSV" and "Download PDF"
   - Each builds a URL: `/api/v1/organizations/${orgId}/reports/export?format={csv|pdf}&tab=${tab}&${paramString}` and opens it via `window.open(url, "_blank")`
   - `paramString` is built from the `params` prop, skipping undefined values
2. In `ReportsPageContent` Overview toolbar, add `<ExportDropdown orgId={orgId} tab="overview" params={{ from, to, period, clientId, projectId }} />` to actions
3. In `AccountingTab` toolbar, add `<ExportDropdown orgId={orgId} tab="accounting" params={{ from: `${selectedYear}-01-01`, to: `${selectedYear}-12-31`, clientId }} />` to actions
4. Import `Download` from lucide-react

**Verify:** `pnpm typecheck` passes. Clicking export triggers a file download.

---

## Commit Strategy

- Commit after each task (or group closely related tasks)
- Phase 1 commits: "feat(reports): add client/project filter support to APIs", "feat(reports): add PageToolbar to report tabs"
- Phase 2 commits: "feat(reports): add saved report presets schema + API", "feat(reports): add saved reports dropdown"
- Phase 3 commits: "feat(reports): add CSV export for reports", "feat(reports): add PDF export for reports", "feat(reports): add export dropdown to toolbars"
