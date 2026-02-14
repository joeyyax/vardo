# My Work Command Center — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the My Work page from a category-based checklist into a time-grouped command center that surfaces all entity types (tasks, invoices, proposals, contracts, expenses, inbox items, calendar events) in urgency-based time buckets with an expanded summary block.

**Architecture:** Restructure the my-work API from category-based sections (Past Due, Due Soon, Needs Triage, etc.) to time-based buckets (Overdue, Today, This Week, Upcoming, Needs Attention). Add queries for proposals/contracts (via `documents` table), expenses (`projectExpenses` table), and ICS calendar events. Store per-user calendar ICS URL in a new `userSettings` table. Redesign the frontend to render a unified timeline feed.

**Tech Stack:** Drizzle ORM, Next.js API routes, React with shadcn/ui, `node-ical` for ICS parsing

**Design doc:** `docs/plans/2026-02-13-my-work-and-inbox-design.md`

---

### Task 1: Add `userSettings` table

**Files:**
- Modify: `lib/db/schema.ts`

**Step 1: Add userSettings table definition**

In `lib/db/schema.ts`, after the `notificationPreferences` table (around line 1514), add:

```typescript
export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  calendarIcsUrl: text("calendar_ics_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

**Step 2: Push schema**

Run: `pnpm db:push`
Expected: New `user_settings` table created.

**Step 3: Verify**

Run: `pnpm typecheck`
Expected: Clean.

**Step 4: Commit**

```bash
git add lib/db/schema.ts
git commit -m "feat: add userSettings table for per-user preferences"
```

---

### Task 2: User settings API

**Files:**
- Create: `app/api/v1/user-settings/route.ts`

**Step 1: Create the API endpoint**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { userSettings } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";

// GET /api/v1/user-settings
export async function GET() {
  try {
    const session = await requireSession();
    const userId = session.user.id;

    const existing = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
    });

    if (!existing) {
      // Auto-create default settings
      const [created] = await db
        .insert(userSettings)
        .values({ userId })
        .returning();
      return NextResponse.json(created);
    }

    return NextResponse.json(existing);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching user settings:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/user-settings
export async function PATCH(request: NextRequest) {
  try {
    const session = await requireSession();
    const userId = session.user.id;
    const body = await request.json();

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if ("calendarIcsUrl" in body) {
      const url = body.calendarIcsUrl;
      // Validate it looks like a URL or is null/empty (to clear)
      if (url && typeof url === "string" && url.trim()) {
        try {
          new URL(url.trim());
          updates.calendarIcsUrl = url.trim();
        } catch {
          return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
        }
      } else {
        updates.calendarIcsUrl = null;
      }
    }

    // Upsert — create if not exists
    const existing = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
    });

    if (existing) {
      const [updated] = await db
        .update(userSettings)
        .set(updates)
        .where(eq(userSettings.userId, userId))
        .returning();
      return NextResponse.json(updated);
    } else {
      const [created] = await db
        .insert(userSettings)
        .values({ userId, ...updates })
        .returning();
      return NextResponse.json(created);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating user settings:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 2: Add userSettings to Drizzle relations if needed**

Check if `lib/db/schema.ts` has a relations section. If so, add:

```typescript
export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(users, { fields: [userSettings.userId], references: [users.id] }),
}));
```

**Step 3: Verify**

Run: `pnpm typecheck`

**Step 4: Commit**

```bash
git add app/api/v1/user-settings/route.ts lib/db/schema.ts
git commit -m "feat: add user settings API for calendar ICS URL"
```

---

### Task 3: Calendar ICS URL on profile page

**Files:**
- Modify: `app/(app)/profile/profile-content.tsx`

**Step 1: Add Calendar section to profile page**

After the PersonalPreferences section (around line 164) and before NotificationPreferences, add a new Card for "Calendar Integration" with:
- A text input for the ICS URL
- A save button
- Fetch current value on mount via `GET /api/v1/user-settings`
- Save via `PATCH /api/v1/user-settings`
- Success toast on save

Follow the existing card pattern from the Profile Information card:

```tsx
// Calendar Integration Card
<Card className="squircle">
  <CardHeader>
    <CardTitle className="text-base">Calendar Integration</CardTitle>
    <CardDescription>
      Connect your calendar to see events alongside your work items.
    </CardDescription>
  </CardHeader>
  <CardContent className="space-y-4">
    <div className="space-y-2">
      <Label htmlFor="icsUrl">Calendar feed URL (ICS)</Label>
      <Input
        id="icsUrl"
        type="url"
        placeholder="https://calendar.google.com/calendar/ical/..."
        value={icsUrl}
        onChange={(e) => setIcsUrl(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        Paste your Google Calendar, Outlook, or Apple Calendar ICS feed URL.
      </p>
    </div>
    <Button
      onClick={handleSaveIcsUrl}
      disabled={savingIcs}
      size="sm"
    >
      {savingIcs ? "Saving..." : "Save"}
    </Button>
  </CardContent>
</Card>
```

**Step 2: Verify**

Run: `pnpm typecheck`
Test manually: go to Profile, paste an ICS URL, save, reload — value persists.

**Step 3: Commit**

```bash
git add app/(app)/profile/profile-content.tsx
git commit -m "feat: add calendar ICS URL input to profile page"
```

---

### Task 4: ICS feed parser utility

**Files:**
- Create: `lib/calendar.ts`

**Step 1: Install node-ical**

Run: `pnpm add node-ical`

**Step 2: Create the parser**

```typescript
import ical from "node-ical";

export type CalendarEvent = {
  id: string;
  title: string;
  start: string; // ISO string
  end: string; // ISO string
  allDay: boolean;
  location?: string;
};

/**
 * Fetch and parse an ICS feed, returning events within the given date range.
 * Returns empty array on any fetch/parse error (non-blocking).
 */
export async function fetchCalendarEvents(
  icsUrl: string,
  rangeStart: Date,
  rangeEnd: Date
): Promise<CalendarEvent[]> {
  try {
    const response = await fetch(icsUrl, {
      signal: AbortSignal.timeout(5000), // 5s timeout
      headers: { "User-Agent": "TimeApp/1.0" },
    });

    if (!response.ok) return [];

    const text = await response.text();
    const parsed = ical.parseICS(text);
    const events: CalendarEvent[] = [];

    for (const [uid, component] of Object.entries(parsed)) {
      if (component.type !== "VEVENT") continue;

      const event = component as ical.VEvent;
      const start = event.start ? new Date(event.start) : null;
      const end = event.end ? new Date(event.end) : start;

      if (!start) continue;

      // Filter to range
      if (start > rangeEnd || (end && end < rangeStart)) continue;

      // Handle recurring events — node-ical expands RRULE into rrule property
      // For the initial build, we handle single + expanded instances
      events.push({
        id: uid,
        title: event.summary || "Untitled event",
        start: start.toISOString(),
        end: end ? end.toISOString() : start.toISOString(),
        allDay: event.datetype === "date",
        location: event.location || undefined,
      });
    }

    // Sort by start time
    events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    return events;
  } catch (error) {
    console.error("Error fetching calendar:", error);
    return []; // Non-blocking — calendar failure shouldn't break the dashboard
  }
}
```

**Step 3: Verify**

Run: `pnpm typecheck`

**Step 4: Commit**

```bash
git add lib/calendar.ts package.json pnpm-lock.yaml
git commit -m "feat: add ICS feed parser for calendar integration"
```

---

### Task 5: Update types for time-grouped feed

**Files:**
- Modify: `lib/types/my-work.ts`

**Step 1: Replace the existing types**

```typescript
export type WorkItemType =
  | "task"
  | "invoice"
  | "inbox_item"
  | "proposal"
  | "contract"
  | "expense"
  | "calendar_event";

export type WorkItem = {
  type: WorkItemType;
  id: string;
  title: string;
  dueDate: string | null;
  status: string;
  priority?: string | null;
  estimateMinutes?: number | null;
  amountCents?: number | null;
  project?: {
    id: string;
    name: string;
    client?: { id: string; name: string; color: string | null };
  } | null;
  // Calendar event fields
  startTime?: string | null;
  endTime?: string | null;
  allDay?: boolean;
  location?: string;
};

export type ActivityItem = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  createdAt: string;
  project?: { id: string; name: string } | null;
  task?: { id: string; name: string } | null;
};

export type WorkloadSummary = {
  today: { minutesTracked: number; tasksCompleted: number };
  thisWeek: {
    minutesTracked: number;
    tasksCompleted: number;
    tasksRemaining: number;
  };
  upcoming: { itemsDueThisWeek: number; estimatedMinutes: number };
  money: {
    unbilledMinutes: number;
    outstandingInvoiceCents: number;
    pendingExpenseCents: number;
  };
};

export type MyWorkData = {
  summary: WorkloadSummary;
  overdue: WorkItem[];
  today: WorkItem[];
  thisWeek: WorkItem[];
  upcoming: WorkItem[];
  needsAttention: WorkItem[];
  recentActivity: ActivityItem[];
};
```

**Step 2: Verify**

Run: `pnpm typecheck`
Expected: Errors in the API route and frontend — that's correct, we'll fix them next.

**Step 3: Commit**

```bash
git add lib/types/my-work.ts
git commit -m "feat: update my-work types for time-grouped feed with all entity types"
```

---

### Task 6: Restructure my-work API — time-based grouping + new entity types

**Files:**
- Modify: `app/api/v1/organizations/[orgId]/my-work/route.ts`

This is the largest task. The API needs to:

1. **Keep existing queries** for tasks, invoices, inbox items
2. **Add queries** for proposals/contracts (documents table) and expenses
3. **Add ICS calendar fetch** (from user settings)
4. **Restructure the response** from category-based to time-based buckets
5. **Expand the summary** with money stats

**Step 1: Add imports**

Add to the existing imports at the top:

```typescript
import { documents, projectExpenses, userSettings } from "@/lib/db/schema";
import { fetchCalendarEvents } from "@/lib/calendar";
```

**Step 2: Add money stats to buildSummary**

Add three more queries to the `buildSummary` function's `Promise.all`:

```typescript
// Unbilled time (time entries not yet invoiced)
db
  .select({ total: sum(timeEntries.durationMinutes) })
  .from(timeEntries)
  .where(
    and(
      eq(timeEntries.organizationId, orgId),
      eq(timeEntries.userId, userId),
      eq(timeEntries.isBillable, true),
      isNull(timeEntries.invoiceId)
    )
  ),

// Outstanding invoice total (sent/overdue, not paid/voided)
db
  .select({ total: sum(invoices.totalCents) })
  .from(invoices)
  .innerJoin(clients, eq(invoices.clientId, clients.id))
  .where(
    and(
      eq(invoices.organizationId, orgId),
      eq(clients.assignedTo, userId),
      not(inArray(invoices.status, ["paid", "voided", "draft"])),
    )
  ),

// Pending (unpaid) expenses total
db
  .select({ total: sum(projectExpenses.amountCents) })
  .from(projectExpenses)
  .where(
    and(
      eq(projectExpenses.organizationId, orgId),
      eq(projectExpenses.createdBy, userId),
      eq(projectExpenses.status, "unpaid")
    )
  ),
```

Update the return value to include:

```typescript
money: {
  unbilledMinutes: Number(unbilledResult[0]?.total) || 0,
  outstandingInvoiceCents: Number(outstandingResult[0]?.total) || 0,
  pendingExpenseCents: Number(pendingExpensesResult[0]?.total) || 0,
},
```

**Step 3: Add document queries (proposals + contracts)**

Add to the main `Promise.all`:

```typescript
// Proposals awaiting response (sent or viewed, not accepted/declined)
db.query.documents.findMany({
  where: and(
    inArray(documents.projectId, projectIds),
    eq(documents.type, "proposal"),
    inArray(documents.status, ["sent", "viewed"])
  ),
  with: {
    project: {
      columns: { id: true, name: true },
      with: { client: { columns: { id: true, name: true, color: true } } },
    },
  },
}),

// Contracts nearing expiration or needing action (sent/viewed)
db.query.documents.findMany({
  where: and(
    inArray(documents.projectId, projectIds),
    eq(documents.type, "contract"),
    inArray(documents.status, ["sent", "viewed"])
  ),
  with: {
    project: {
      columns: { id: true, name: true },
      with: { client: { columns: { id: true, name: true, color: true } } },
    },
  },
}),
```

**Step 4: Add expense queries**

```typescript
// Unpaid expenses
db.query.projectExpenses.findMany({
  where: and(
    eq(projectExpenses.organizationId, orgId),
    eq(projectExpenses.createdBy, userId),
    eq(projectExpenses.status, "unpaid")
  ),
  with: {
    project: {
      columns: { id: true, name: true },
      with: { client: { columns: { id: true, name: true, color: true } } },
    },
  },
}),
```

**Step 5: Fetch calendar events**

After the main `Promise.all`, fetch the user's calendar:

```typescript
// Fetch calendar events (non-blocking)
const userSettingsRow = await db.query.userSettings.findFirst({
  where: eq(userSettings.userId, userId),
});

const thirtyDaysFromNow = new Date(startOfToday);
thirtyDaysFromNow.setDate(startOfToday.getDate() + 30);

const calendarEvents = userSettingsRow?.calendarIcsUrl
  ? await fetchCalendarEvents(
      userSettingsRow.calendarIcsUrl,
      startOfToday,
      thirtyDaysFromNow
    )
  : [];
```

**Step 6: Build time-based buckets**

Replace the existing response construction with a bucket-based approach. Create a helper function:

```typescript
function assignToBucket(
  item: WorkItem,
  todayStr: string,
  endOfWeekStr: string,
  thirtyDaysStr: string
): "overdue" | "today" | "thisWeek" | "upcoming" | "needsAttention" {
  if (!item.dueDate) return "needsAttention";
  if (item.dueDate < todayStr) return "overdue";
  if (item.dueDate === todayStr) return "today";
  if (item.dueDate <= endOfWeekStr) return "thisWeek";
  if (item.dueDate <= thirtyDaysStr) return "upcoming";
  return "upcoming";
}
```

Collect ALL work items (tasks, invoices, proposals, contracts, expenses, inbox items, calendar events) into a flat array, then sort into buckets:

- **Overdue**: dueDate < today, status not done/paid/voided
- **Today**: dueDate === today, or calendar events starting today
- **This Week**: dueDate within this week
- **Upcoming**: dueDate within 30 days
- **Needs Attention**: undated items — inbox items needing triage, proposals awaiting response, unassigned items, blocked tasks

**Step 7: Add mapper functions for new entity types**

```typescript
function mapDocumentToWorkItem(doc: DocumentWithProject): WorkItem {
  return {
    type: doc.type === "proposal" ? "proposal" : "contract",
    id: doc.id,
    title: doc.title || `${doc.type === "proposal" ? "Proposal" : "Contract"} (untitled)`,
    dueDate: doc.sentAt ? new Date(doc.sentAt).toISOString().split("T")[0] : null,
    status: doc.status ?? "draft",
    project: doc.project
      ? { id: doc.project.id, name: doc.project.name, client: doc.project.client ?? undefined }
      : null,
  };
}

function mapExpenseToWorkItem(expense: ExpenseWithProject): WorkItem {
  return {
    type: "expense",
    id: expense.id,
    title: expense.description,
    dueDate: expense.date,
    status: expense.status ?? "unpaid",
    amountCents: expense.amountCents,
    project: expense.project
      ? { id: expense.project.id, name: expense.project.name, client: expense.project.client ?? undefined }
      : null,
  };
}

function mapCalendarEventToWorkItem(event: CalendarEvent): WorkItem {
  const startDate = new Date(event.start);
  return {
    type: "calendar_event",
    id: event.id,
    title: event.title,
    dueDate: formatLocalDate(startDate),
    status: "scheduled",
    startTime: event.start,
    endTime: event.end,
    allDay: event.allDay,
    location: event.location,
  };
}
```

**Step 8: Update the response shape**

```typescript
const response: MyWorkData = {
  summary,
  overdue: buckets.overdue,
  today: buckets.today,
  thisWeek: buckets.thisWeek,
  upcoming: buckets.upcoming,
  needsAttention: buckets.needsAttention,
  recentActivity: recentActivities.map(mapActivity),
};
```

**Step 9: Update the emptyResponse helper**

```typescript
function emptyResponse(): MyWorkData {
  return {
    summary: {
      today: { minutesTracked: 0, tasksCompleted: 0 },
      thisWeek: { minutesTracked: 0, tasksCompleted: 0, tasksRemaining: 0 },
      upcoming: { itemsDueThisWeek: 0, estimatedMinutes: 0 },
      money: { unbilledMinutes: 0, outstandingInvoiceCents: 0, pendingExpenseCents: 0 },
    },
    overdue: [],
    today: [],
    thisWeek: [],
    upcoming: [],
    needsAttention: [],
    recentActivity: [],
  };
}
```

**Step 10: Verify**

Run: `pnpm typecheck`

**Step 11: Commit**

```bash
git add app/api/v1/organizations/[orgId]/my-work/route.ts
git commit -m "feat: restructure my-work API to time-based buckets with all entity types"
```

---

### Task 7: Redesign my-work-content.tsx

**Files:**
- Modify: `app/(app)/work/my-work-content.tsx`

**Step 1: Update section config for time-based buckets**

Replace `SECTION_CONFIG` with:

```typescript
const SECTION_CONFIG: {
  key: keyof Pick<MyWorkData, "overdue" | "today" | "thisWeek" | "upcoming" | "needsAttention">;
  label: string;
  icon: typeof AlertCircle;
  iconClassName: string;
  defaultOpen: boolean;
}[] = [
  { key: "overdue", label: "Overdue", icon: AlertCircle, iconClassName: "text-red-500", defaultOpen: true },
  { key: "today", label: "Today", icon: CalendarClock, iconClassName: "text-foreground", defaultOpen: true },
  { key: "thisWeek", label: "This Week", icon: CalendarDays, iconClassName: "text-blue-500", defaultOpen: true },
  { key: "upcoming", label: "Upcoming", icon: Clock, iconClassName: "text-muted-foreground", defaultOpen: false },
  { key: "needsAttention", label: "Needs Attention", icon: Inbox, iconClassName: "text-amber-500", defaultOpen: true },
];
```

**Step 2: Update item type icons**

```typescript
const ITEM_TYPE_ICONS: Record<string, typeof CheckSquare> = {
  task: CheckSquare,
  invoice: FileText,
  inbox_item: Mail,
  proposal: Send,
  contract: FileSignature,
  expense: Receipt,
  calendar_event: Calendar,
};
```

Import the new icons from lucide-react: `Send`, `FileSignature`, `Receipt`, `Calendar`, `CalendarDays`, `Clock`, `DollarSign`.

**Step 3: Update handleItemClick**

Add navigation for new entity types:

```typescript
case "proposal":
case "contract":
  router.push(`/documents/${item.id}`);
  break;
case "expense":
  router.push(`/expenses?expense=${item.id}`);
  break;
case "calendar_event":
  // No navigation for calendar events
  break;
```

**Step 4: Update WorkloadSummaryBlock**

Add money stats row:

```typescript
function WorkloadSummaryBlock({ summary }: { summary: WorkloadSummary }) {
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p>
        <span className="font-medium text-foreground">Today:</span>{" "}
        {formatHoursHuman(summary.today.minutesTracked)} tracked
        {summary.today.tasksCompleted > 0 &&
          `, ${summary.today.tasksCompleted} task${summary.today.tasksCompleted !== 1 ? "s" : ""} completed`}
      </p>
      <p>
        <span className="font-medium text-foreground">This week:</span>{" "}
        {formatHoursHuman(summary.thisWeek.minutesTracked)} tracked,{" "}
        {summary.thisWeek.tasksCompleted} completed,{" "}
        {summary.thisWeek.tasksRemaining} remaining
      </p>
      <p>
        <span className="font-medium text-foreground">Upcoming:</span>{" "}
        {summary.upcoming.itemsDueThisWeek} item
        {summary.upcoming.itemsDueThisWeek !== 1 ? "s" : ""} due this week
        {summary.upcoming.estimatedMinutes > 0 &&
          ` (~${formatHoursHuman(summary.upcoming.estimatedMinutes)} estimated)`}
      </p>
      {(summary.money.unbilledMinutes > 0 ||
        summary.money.outstandingInvoiceCents > 0 ||
        summary.money.pendingExpenseCents > 0) && (
        <p>
          <span className="font-medium text-foreground">Money:</span>{" "}
          {[
            summary.money.unbilledMinutes > 0 &&
              `${formatHoursHuman(summary.money.unbilledMinutes)} unbilled`,
            summary.money.outstandingInvoiceCents > 0 &&
              `${formatCurrency(summary.money.outstandingInvoiceCents)} outstanding`,
            summary.money.pendingExpenseCents > 0 &&
              `${formatCurrency(summary.money.pendingExpenseCents)} in pending expenses`,
          ]
            .filter(Boolean)
            .join(", ")}
        </p>
      )}
    </div>
  );
}
```

Add helper:

```typescript
function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
```

**Step 5: Update WorkItemRow for calendar events**

Calendar events should display the time instead of due date:

```typescript
{item.type === "calendar_event" && item.startTime && (
  <span className="text-xs text-muted-foreground shrink-0">
    {item.allDay
      ? "All day"
      : new Date(item.startTime).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        })}
  </span>
)}
```

Also display location if present:

```typescript
{item.location && (
  <span className="text-xs text-muted-foreground ml-2">{item.location}</span>
)}
```

**Step 6: Update WorkItemRow for expenses**

Show amount for expenses:

```typescript
{item.type === "expense" && item.amountCents && (
  <span className="text-xs font-medium shrink-0">
    {formatCurrency(item.amountCents)}
  </span>
)}
```

**Step 7: Update the main render to use new section keys**

Update the section mapping in the main component to use the new `MyWorkData` shape (overdue, today, thisWeek, upcoming, needsAttention).

**Step 8: Verify**

Run: `pnpm typecheck`
Test manually: load My Work page, verify sections render, calendar events appear if ICS URL is set.

**Step 9: Commit**

```bash
git add app/(app)/work/my-work-content.tsx
git commit -m "feat: redesign my-work dashboard with time-grouped feed and all entity types"
```

---

### Task 8: Wire second-member nudge trigger

**Files:**
- Modify: `app/api/invitations/[token]/route.ts`

**Step 1: Add nudge trigger after invitation acceptance**

After the invitation is accepted (after line 151 where `returning()` is called), add:

```typescript
// Check if this is the second member — trigger nudge if so
try {
  const orgId = invitation.organizationId; // Get the org from the invitation's project
  if (orgId) {
    const memberCount = await db
      .select({ total: count() })
      .from(memberships)
      .where(eq(memberships.organizationId, orgId));

    if (Number(memberCount[0]?.total) === 2) {
      // This is the second member — set the nudge flag
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { features: true },
      });
      const features = (org?.features as OrgFeatures) ?? { ...DEFAULT_ORG_FEATURES };
      features.secondMemberNudge = true;
      await db
        .update(organizations)
        .set({ features })
        .where(eq(organizations.id, orgId));
    }
  }
} catch (error) {
  // Non-blocking — nudge failure shouldn't break invitation flow
  console.error("Error checking second member nudge:", error);
}
```

Note: Need to check how the invitation relates to the org. The invitation is a `projectInvitations` record — it has a `projectId`. We need to get the org from the project's client chain. Check the actual invitation data shape and adjust the query accordingly.

**Step 2: Add required imports**

```typescript
import { memberships, organizations } from "@/lib/db/schema";
import type { OrgFeatures } from "@/lib/db/schema";
import { DEFAULT_ORG_FEATURES } from "@/lib/db/schema";
import { count } from "drizzle-orm";
```

**Step 3: Verify**

Run: `pnpm typecheck`

**Step 4: Commit**

```bash
git add app/api/invitations/[token]/route.ts
git commit -m "feat: wire second-member nudge trigger on invitation acceptance"
```

---

### Task 9: Backfill existing entity data

**Files:**
- Create: `scripts/backfill-assignments.ts`

**Step 1: Create a one-time backfill script**

This script sets `defaultAssignee` on existing orgs that have exactly 1 member and then populates `assignedTo` on all entities using the resolver.

```typescript
import { db } from "@/lib/db";
import { organizations, memberships, clients, projects, tasks, inboxItems } from "@/lib/db/schema";
import { eq, isNull, sql, count as drizzleCount } from "drizzle-orm";
import { resolveAssignee } from "@/lib/assignment";
import type { OrgFeatures } from "@/lib/db/schema";

async function backfill() {
  console.log("Starting assignment backfill...");

  // 1. Set defaultAssignee on single-member orgs that don't have one
  const allOrgs = await db.query.organizations.findMany({
    columns: { id: true, features: true },
  });

  for (const org of allOrgs) {
    const features = org.features as OrgFeatures | null;
    if (features?.defaultAssignee) continue; // Already set

    const members = await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(eq(memberships.organizationId, org.id));

    if (members.length === 1) {
      const updatedFeatures = { ...(features ?? {}), defaultAssignee: members[0].userId };
      await db
        .update(organizations)
        .set({ features: updatedFeatures })
        .where(eq(organizations.id, org.id));
      console.log(`Set defaultAssignee for org ${org.id} to ${members[0].userId}`);
    }
  }

  // 2. Backfill assignedTo on clients without one
  const unassignedClients = await db.query.clients.findMany({
    where: isNull(clients.assignedTo),
    columns: { id: true, organizationId: true },
  });

  for (const client of unassignedClients) {
    const assignee = await resolveAssignee({ orgId: client.organizationId });
    if (assignee) {
      await db.update(clients).set({ assignedTo: assignee }).where(eq(clients.id, client.id));
    }
  }
  console.log(`Backfilled ${unassignedClients.length} clients`);

  // 3. Backfill assignedTo on projects without one
  const unassignedProjects = await db.query.projects.findMany({
    where: isNull(projects.assignedTo),
    columns: { id: true, clientId: true },
    with: { client: { columns: { organizationId: true } } },
  });

  for (const project of unassignedProjects) {
    const assignee = await resolveAssignee({
      clientId: project.clientId,
      orgId: project.client?.organizationId ?? "",
    });
    if (assignee) {
      await db.update(projects).set({ assignedTo: assignee }).where(eq(projects.id, project.id));
    }
  }
  console.log(`Backfilled ${unassignedProjects.length} projects`);

  // 4. Backfill assignedTo on tasks without one
  const unassignedTasks = await db.query.tasks.findMany({
    where: isNull(tasks.assignedTo),
    columns: { id: true, projectId: true },
    with: { project: { columns: { id: true }, with: { client: { columns: { organizationId: true } } } } },
  });

  for (const task of unassignedTasks) {
    const assignee = await resolveAssignee({
      projectId: task.projectId,
      orgId: task.project?.client?.organizationId ?? "",
    });
    if (assignee) {
      await db.update(tasks).set({ assignedTo: assignee }).where(eq(tasks.id, task.id));
    }
  }
  console.log(`Backfilled ${unassignedTasks.length} tasks`);

  console.log("Backfill complete.");
}

backfill().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

**Step 2: Run the backfill**

Run: `npx tsx scripts/backfill-assignments.ts`

**Step 3: Verify**

Check that entities now have `assignedTo` populated. The My Work dashboard should start showing items.

**Step 4: Commit**

```bash
git add scripts/backfill-assignments.ts
git commit -m "feat: add one-time backfill script for entity assignments"
```

---

### Task 10: Update product docs

**Files:**
- Modify: `docs/product/APP_BRIEF.md` (if it exists)
- Modify: `docs/plans/2026-02-13-my-work-and-inbox-design.md`

**Step 1: Update design doc**

Add a note at the top of the design doc that Phase 1 and Phase 2 are complete. Document:
- The time-grouped feed structure (replacing category-based sections)
- Calendar integration via ICS feed
- All entity types in the feed (tasks, invoices, proposals, contracts, expenses, inbox items, calendar events)
- Expanded summary with money stats
- User settings table for per-user preferences

**Step 2: Update product docs if they exist**

If `docs/product/APP_BRIEF.md` has a section about the dashboard or My Work, update it to reflect the current implementation.

**Step 3: Commit**

```bash
git add docs/
git commit -m "docs: update my-work design docs for command center redesign"
```
