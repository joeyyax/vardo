# Notifications System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the notification system with watch/unwatch UI, notification history page, email delivery for all notification types, and daily digest option.

**Architecture:** 4 independent layers: (1) watch/unwatch API + UI for tasks/projects/expenses + auto-subscription expansion, (2) full notification history page with filters + sidebar nav link, (3) unified notification email template wired into createNotification, (4) daily digest schema field + cron endpoint + preferences UI update.

**Tech Stack:** Next.js App Router, React, Tailwind CSS, shadcn/ui, Drizzle ORM, React Email, Resend, sonner toasts.

**Design doc:** `docs/plans/2026-02-12-notifications-design.md`

---

## Layer 1: Watch/Unwatch

### Task 1: Shared ensureWatcher helper

**Files:**
- Modify: `lib/notifications.ts`

**Context:** The `ensureWatcher` function is currently duplicated in 7 comment route files (tasks, projects, expenses, clients, contacts, invoices, documents). Each is nearly identical — check if watcher exists, insert if not. Extract to a shared helper.

**Step 1: Add generic ensureWatcher to lib/notifications.ts**

Add these imports and function at the end of the file:

```typescript
import {
  taskWatchers, projectWatchers, expenseWatchers,
} from "@/lib/db/schema";

type WatcherTable = "task" | "project" | "expense";

const watcherConfigs = {
  task: { table: taskWatchers, idColumn: "taskId" },
  project: { table: projectWatchers, idColumn: "projectId" },
  expense: { table: expenseWatchers, idColumn: "expenseId" },
} as const;

export async function ensureWatcher(
  entityType: WatcherTable,
  entityId: string,
  userId: string,
  reason: string
) {
  try {
    const config = watcherConfigs[entityType];
    const table = config.table;
    const idCol = config.idColumn;

    const existing = await db.query[`${entityType}Watchers`].findFirst({
      where: and(
        eq((table as any)[idCol], entityId),
        eq((table as any).userId, userId)
      ),
    });

    if (!existing) {
      await db.insert(table).values({
        [idCol]: entityId,
        userId,
        reason,
      } as any);
    }
  } catch (error) {
    console.error(`Error ensuring ${entityType} watcher:`, error);
  }
}
```

Note: The exact typing may need adjustment — the subagent should look at the actual schema table types and drizzle query patterns to make this type-safe. The key requirement is a single function that works for task/project/expense watcher tables.

**Step 2: Verify with typecheck**

Run: `pnpm typecheck`

**Step 3: Commit**

```bash
git add lib/notifications.ts
git commit -m "feat: extract shared ensureWatcher helper for watcher tables"
```

---

### Task 2: Watcher API endpoints for tasks

**Files:**
- Create: `app/api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/watchers/route.ts`

**Context:**
- Schema: `taskWatchers` table with composite PK (taskId, userId), reason field, createdAt
- Follow pattern from existing comment routes for auth/org verification
- Route params: `{ orgId, projectId, taskId }`
- Auth: `requireOrg()` + org ID check

**Step 1: Create the route with GET, POST, DELETE**

**GET** — List watchers for the task + `isWatching` flag:
- Query `taskWatchers` where taskId matches
- Join with `users` to get name/email/image
- Check if current user is in the list
- Return: `{ watchers: [...], isWatching: boolean, count: number }`

**POST** — Add current user as watcher:
- Body: `{ reason?: string }` (default: `"manual"`)
- Check if already watching, skip if so
- Insert into `taskWatchers`
- Return: `{ success: true }`

**DELETE** — Remove current user as watcher:
- Delete from `taskWatchers` where taskId + userId match
- Return: `{ success: true }`

**Step 2: Verify with typecheck**

Run: `pnpm typecheck`

**Step 3: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/projects/\[projectId\]/tasks/\[taskId\]/watchers/route.ts
git commit -m "feat: add watcher API endpoints for tasks"
```

---

### Task 3: Watcher API endpoints for projects

**Files:**
- Create: `app/api/v1/organizations/[orgId]/projects/[projectId]/watchers/route.ts`

**Context:** Same pattern as Task 2 but for `projectWatchers` table. Route params: `{ orgId, projectId }`.

**Step 1: Create the route with GET, POST, DELETE**

Same structure as task watchers — GET returns list + isWatching, POST adds manual watcher, DELETE removes.

**Step 2: Verify with typecheck, commit**

```bash
git add app/api/v1/organizations/\[orgId\]/projects/\[projectId\]/watchers/route.ts
git commit -m "feat: add watcher API endpoints for projects"
```

---

### Task 4: Watcher API endpoints for expenses

**Files:**
- Create: `app/api/v1/organizations/[orgId]/expenses/[expenseId]/watchers/route.ts`

**Context:** Same pattern as Tasks 2-3 but for `expenseWatchers` table. Route params: `{ orgId, expenseId }`.

**Step 1: Create the route with GET, POST, DELETE**

Same structure. Note: expenses are org-scoped (not project-scoped), so the route is directly under expenses.

**Step 2: Verify with typecheck, commit**

```bash
git add app/api/v1/organizations/\[orgId\]/expenses/\[expenseId\]/watchers/route.ts
git commit -m "feat: add watcher API endpoints for expenses"
```

---

### Task 5: WatchButton component

**Files:**
- Create: `components/watch-button.tsx`

**Context:**
- Reusable across task dialog, project dashboard, expense modal
- Calls the watcher API endpoints created in Tasks 2-4
- Placed in sticky headers of two-panel detail modals

**Step 1: Create the component**

```tsx
"use client";

type WatchButtonProps = {
  entityType: "task" | "project" | "expense";
  entityId: string;
  orgId: string;
  projectId?: string; // Required for tasks and projects
};
```

**Behavior:**
- On mount: GET watchers endpoint → set `isWatching` and `watcherCount`
- Click toggles: POST (watch) or DELETE (unwatch)
- Optimistic state update
- UI: Button with Eye icon + "Watch" or EyeOff icon + "Watching" text
- Tooltip shows watcher count: "X people watching"
- Use `variant="ghost"` and `size="sm"` to fit in detail modal headers

**API URL construction:**
- Task: `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${entityId}/watchers`
- Project: `/api/v1/organizations/${orgId}/projects/${entityId}/watchers`
- Expense: `/api/v1/organizations/${orgId}/expenses/${entityId}/watchers`

**Step 2: Verify with typecheck, commit**

```bash
git add components/watch-button.tsx
git commit -m "feat: add reusable WatchButton component"
```

---

### Task 6: Wire WatchButton into task dialog

**Files:**
- Modify: `components/projects/task-dialog.tsx`

**Context:**
- The task dialog has a sticky header area with action buttons (Edit, Archive, Delete, Close)
- Add WatchButton next to these action buttons
- Only show when viewing an existing task (not creating new)
- Requires orgId and projectId props — check what's already passed to the component

**Step 1: Add WatchButton to the task dialog header**

Import `WatchButton` and render it in the sticky header's action buttons row, before the Edit button. Only show when the task has an id (existing task, not new).

**Step 2: Verify with typecheck, commit**

```bash
git add components/projects/task-dialog.tsx
git commit -m "feat: add watch button to task dialog"
```

---

### Task 7: Wire WatchButton into expense detail modal

**Files:**
- Modify: `components/expenses/expense-detail-modal.tsx`

**Context:** Same pattern as Task 6 but for the expense detail modal. Add WatchButton to the sticky header area.

**Step 1: Add WatchButton to the expense modal header**

**Step 2: Verify with typecheck, commit**

```bash
git add components/expenses/expense-detail-modal.tsx
git commit -m "feat: add watch button to expense detail modal"
```

---

### Task 8: Wire WatchButton into project dashboard

**Files:**
- Modify: Find the project detail/dashboard component (likely `components/projects/project-dashboard.tsx` or the project detail page)

**Context:** Projects may not have a two-panel modal — they might use a full page. The WatchButton should go in the project page header area near the project title/actions.

**Step 1: Find the project detail component and add WatchButton**

The subagent should search for the project detail page/component and add WatchButton to its header area.

**Step 2: Verify with typecheck, commit**

```bash
git commit -m "feat: add watch button to project dashboard"
```

---

### Task 9: Auto-subscribe task creators and assignees

**Files:**
- Modify: `app/api/v1/organizations/[orgId]/projects/[projectId]/tasks/route.ts` (POST handler — task creation)
- Modify: `app/api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/route.ts` (PATCH handler — assignment)

**Context:**
- Import `ensureWatcher` from `@/lib/notifications`
- On task creation: call `ensureWatcher("task", taskId, session.user.id, "creator")`
- On task assignment (when assignedTo changes): call `ensureWatcher("task", taskId, assignedTo, "assignee")`
- The existing PATCH handler already calls `notifyAssignment` — add `ensureWatcher` just before or after

**Step 1: Add auto-subscribe on task creation**

In the POST handler, after the task is created and we have the new task ID, call ensureWatcher.

**Step 2: Add auto-subscribe on task assignment**

In the PATCH handler, when `assignedTo` is set, call ensureWatcher for the new assignee.

**Step 3: Verify with typecheck, commit**

```bash
git commit -m "feat: auto-subscribe task creators and assignees as watchers"
```

---

## Layer 2: Notification History Page

### Task 10: Add type filter to notifications API

**Files:**
- Modify: `app/api/v1/notifications/route.ts`

**Context:** The GET handler already supports `unreadOnly`, `limit`, `offset` query params. Add `type` filter.

**Step 1: Add type filter**

In the GET handler, after parsing existing params:
```typescript
const type = searchParams.get("type");
// Add to conditions
if (type && NOTIFICATION_TYPES.includes(type as NotificationType)) {
  conditions.push(eq(notifications.type, type as NotificationType));
}
```

Import `NOTIFICATION_TYPES` from schema.

**Step 2: Verify with typecheck, commit**

```bash
git add app/api/v1/notifications/route.ts
git commit -m "feat: add type filter to notifications API"
```

---

### Task 11: Notifications page

**Files:**
- Create: `app/(app)/notifications/page.tsx`

**Context:**
- Server component wrapper (just renders the client content component)
- Protected by auth (layout already handles this)

- Create: `app/(app)/notifications/notifications-content.tsx`

**Client component with:**
- Page header: "Notifications"
- Toolbar: type filter (Select with options: All, Assignments, Comments, Status Changes, Blockers Resolved, Client Comments), "Mark all read" button (right-aligned)
- Notification list: full-width rows matching the bell dropdown's NotificationItem style but larger
  - Each row: type icon (from TYPE_ICONS map), content, actor name, timestamp, unread dot
  - Click navigates to entity (same as bell dropdown's handleNotificationClick)
  - Mark as read on click
- "Load more" button at bottom (increments offset by limit)
- Loading state: Loader2 spinner
- Empty state: "No notifications yet."

**Reuse:** Extract `TYPE_ICONS` and `NotificationItem` from `notification-bell.tsx` into a shared location, or duplicate for the page (the page version will be slightly different — full-width, more detail).

**Step 1: Create page.tsx and notifications-content.tsx**

**Step 2: Verify with typecheck, commit**

```bash
git commit -m "feat: add notifications history page"
```

---

### Task 12: Add Notifications to sidebar nav

**Files:**
- Modify: `components/layout/sidebar-nav.tsx`

**Context:**
- Add a "Notifications" item to the `navItems` array
- Use `Bell` icon from lucide
- No feature gate (always visible)
- Position: after Settings (bottom of nav), or before Settings

**Step 1: Add Bell import and nav item**

Add to navItems array, before Settings:
```typescript
{
  label: "Notifications",
  href: "/notifications",
  icon: Bell,
  description: "View all notifications",
},
```

**Step 2: Verify with typecheck, commit**

```bash
git add components/layout/sidebar-nav.tsx
git commit -m "feat: add notifications link to sidebar nav"
```

---

## Layer 3: Email Delivery

### Task 13: Notification email template

**Files:**
- Create: `lib/email/templates/notification.tsx`

**Context:**
- Single reusable React Email template for all notification types
- Follow the style from `lib/email/templates/task-assignment.tsx` (same colors, typography, layout)
- Parameterized by notification type

**Step 1: Create the template**

```tsx
interface NotificationEmailProps {
  type: string;
  heading: string;      // e.g., "Task assigned to you", "New comment"
  content: string;      // The notification content text
  actorName?: string;
  actionUrl: string;    // "View in app" button link
  actionLabel?: string; // Default: "View"
  footerText: string;   // e.g., "You received this because you're watching this task"
}
```

Use the same styling constants as task-assignment.tsx (main, container, heading, button, footer, etc.).

**Step 2: Verify with typecheck, commit**

```bash
git add lib/email/templates/notification.tsx
git commit -m "feat: add reusable notification email template"
```

---

### Task 14: Wire email sending into createNotification

**Files:**
- Modify: `lib/notifications.ts`

**Context:**
- After inserting the notification, send email if enabled
- Check `emailEnabled` preference (already fetched in createNotification)
- Check `emailDelivery` preference — if `'daily'`, skip (digest handles it). Note: this field doesn't exist yet, so default to `'immediate'` if missing.
- Look up the user's email from the `users` table
- Build subject and content based on notification type
- Fire-and-forget (same pattern as sendAssignmentEmail)
- Mark `emailSent: true` on the notification after sending

**Step 1: Add email sending logic to createNotification**

After the notification is inserted successfully:
1. Check if `prefs?.emailEnabled !== false` (default to true)
2. Check if `prefs?.emailDelivery !== 'daily'` (default to immediate)
3. If both pass, fire-and-forget: `sendNotificationEmail({ notificationId, userId, type, content, taskId }).catch(err => ...)`

**Step 2: Create sendNotificationEmail helper**

Private async function in the same file. Pattern similar to existing `sendAssignmentEmail`:
- Check `isEmailConfigured()`
- Look up user email
- Build subject line based on type
- Build action URL (to task, project, etc.)
- Render `NotificationEmail` template
- Call `sendEmail()`
- Update notification: `emailSent = true`

Subject line mapping:
- assigned: `"${actorName} assigned you to "${taskName}""` (keep existing)
- comment: `"${actorName} commented on "${taskName}""`
- status_changed: `"Task status changed: ${taskName}"`
- blocker_resolved: `"Blocker resolved: ${taskName}"`
- client_comment: `"Client comment on "${taskName}""`
- mentioned: `"${actorName} mentioned you"`
- edit_requested: `"Edit requested on "${taskName}""`

**Step 3: Remove the separate sendAssignmentEmail logic from notifyAssignment**

Since createNotification now handles all email sending, the explicit `sendAssignmentEmail` call in `notifyAssignment` is redundant. Remove it to avoid duplicate emails.

**Step 4: Verify with typecheck, commit**

```bash
git add lib/notifications.ts
git commit -m "feat: wire email sending into all notification types"
```

---

## Layer 4: Daily Digest

### Task 15: Add emailDelivery field to schema

**Files:**
- Modify: `lib/db/schema.ts`

**Context:** Add `emailDelivery` column to `notificationPreferences` table.

**Step 1: Add the field**

In the `notificationPreferences` table definition, after `emailEnabled`:
```typescript
emailDelivery: text("email_delivery").default("immediate"),
// Values: "immediate" | "daily"
```

**Step 2: Push schema changes**

Run: `pnpm db:push`

**Step 3: Verify with typecheck, commit**

```bash
git add lib/db/schema.ts
git commit -m "feat: add emailDelivery field to notification preferences"
```

---

### Task 16: Update notification preferences UI

**Files:**
- Modify: `app/(app)/settings/notification-preferences.tsx`

**Context:**
- When `emailEnabled` is true, show an additional control for delivery preference
- Options: "Immediate" (send as they happen) or "Daily digest" (batched once per day)
- Use a Select component (consistent with other settings selectors)

**Step 1: Add emailDelivery to the Preferences type and PATCH payload**

Add `emailDelivery: "immediate" | "daily"` to the Preferences type. Include it in the fetch and save logic.

**Step 2: Add delivery preference UI**

Below the email toggle, when `emailEnabled` is true, render:
```tsx
<Select value={prefs.emailDelivery} onValueChange={(v) => updatePref("emailDelivery", v)}>
  <SelectTrigger>
    <SelectValue />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="immediate">Immediate</SelectItem>
    <SelectItem value="daily">Daily digest</SelectItem>
  </SelectContent>
</Select>
```

**Step 3: Update the preferences API PATCH handler**

Modify: `app/api/v1/notifications/preferences/route.ts`

Add `emailDelivery` to the allowed fields in the PATCH handler.

**Step 4: Verify with typecheck, commit**

```bash
git commit -m "feat: add email delivery preference (immediate vs daily digest)"
```

---

### Task 17: Digest email template

**Files:**
- Create: `lib/email/templates/digest.tsx`

**Context:**
- Groups notifications by type for a summary email
- Subject: "You have X new notifications"
- Body: sections per type with count and summary lines, "View all" button

**Step 1: Create the template**

```tsx
interface DigestEmailProps {
  userName: string;
  notifications: Array<{
    type: string;
    content: string;
    createdAt: string;
  }>;
  viewAllUrl: string;
}
```

Group notifications by type, show count + first 3 items per type. "View all notifications" button at bottom.

**Step 2: Verify with typecheck, commit**

```bash
git add lib/email/templates/digest.tsx
git commit -m "feat: add daily digest email template"
```

---

### Task 18: Digest cron endpoint

**Files:**
- Create: `app/api/cron/send-notification-digest/route.ts`

**Context:**
- Follow pattern from existing cron routes (`app/api/cron/send-reports/route.ts`, etc.)
- Called daily by external scheduler
- No auth (internal endpoint) — but verify with a CRON_SECRET header if one exists in the pattern

**Step 1: Create the cron route**

Logic:
1. Query all users where `notificationPreferences.emailDelivery = 'daily'` and `emailEnabled = true`
2. For each user, query `notifications` where `emailSent = false` and `userId = user.id`
3. If no unsent notifications, skip user
4. Render `DigestEmail` template with grouped notifications
5. Send via `sendEmail()`
6. Batch update: set `emailSent = true` for all included notifications

**Step 2: Verify with typecheck, commit**

```bash
git add app/api/cron/send-notification-digest/route.ts
git commit -m "feat: add daily notification digest cron endpoint"
```

---

### Task 19: Update PLATFORM_EXPANSION.md

**Files:**
- Modify: `docs/PLATFORM_EXPANSION.md`

**Step 1: Mark Phase 11 items as complete**

Check off all completed items. Mark Phase 11 as complete.

**Step 2: Commit**

```bash
git add docs/PLATFORM_EXPANSION.md
git commit -m "docs: mark Phase 11 notifications as complete"
```
