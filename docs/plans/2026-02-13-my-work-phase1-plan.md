# My Work — Phase 1: Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add entity ownership (`assignedTo`) to clients and projects, `dueDate` to tasks, `assignedTo` to inbox items, and default assignment inheritance so everything routes to the right person automatically.

**Architecture:** Add columns to existing tables, wire assignment inheritance into entity creation API routes, add assignee selectors to edit forms using the existing member selector pattern from task-detail-edit.tsx. Single-user orgs auto-set the default assignee. Bulk reassignment endpoint for team changes.

**Tech Stack:** Drizzle ORM (schema + push), Next.js API routes, React forms with shadcn/ui Select, Zod validation

**Design doc:** `docs/plans/2026-02-13-my-work-and-inbox-design.md`

---

### Task 1: Schema migration — add columns

**Files:**
- Modify: `lib/db/schema.ts`

**Step 1: Add `assignedTo` to clients table**

In `lib/db/schema.ts`, in the `clients` table definition (around line 262, before `createdAt`), add:

```typescript
assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
```

**Step 2: Add `assignedTo` to projects table**

In the `projects` table definition (around line 512, before `createdAt`), add:

```typescript
assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
```

**Step 3: Add `dueDate` to tasks table**

In the `tasks` table definition (around line 619, before `metadata`), add:

```typescript
dueDate: date("due_date"),
```

**Step 4: Add `assignedTo` to inbox_items table**

In the `inboxItems` table definition (around line 1400, before `createdAt`), add:

```typescript
assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
```

**Step 5: Push schema**

Run: `pnpm db:push`
Expected: Columns added to all four tables, no data loss.

**Step 6: Verify**

Run: `pnpm typecheck`
Expected: Clean (new columns are optional/nullable, no breaking changes).

**Step 7: Commit**

```bash
git add lib/db/schema.ts
git commit -m "feat: add assignedTo to clients/projects/inbox_items, dueDate to tasks"
```

---

### Task 2: Org settings — defaultAssignee

**Files:**
- Modify: `lib/db/schema.ts` (OrgFeatures type)
- Modify: `app/(app)/settings/settings-form.tsx`
- Modify: API route for org settings PATCH

**Step 1: Add `defaultAssignee` to OrgFeatures type**

Find the `OrgFeatures` type in `lib/db/schema.ts` and add:

```typescript
defaultAssignee?: string | null;
```

Also update `DEFAULT_ORG_FEATURES` to include:

```typescript
defaultAssignee: null,
```

**Step 2: Add assignee selector to settings form**

In `app/(app)/settings/settings-form.tsx`:
- Fetch org members using `GET /api/v1/organizations/{orgId}/members`
- Add a Select field for "Default Assignee" in the General section
- Pattern: match the existing member selector from `components/projects/task-detail-edit.tsx` (lines 447-476)
- Include an "Unassigned" option that sets the value to `null`

**Step 3: Wire into settings PATCH**

Find the org settings PATCH handler and ensure `defaultAssignee` is persisted in the features/settings JSON.

**Step 4: Verify**

Run: `pnpm typecheck`
Test manually: open Settings, set a default assignee, save, reload — value persists.

**Step 5: Commit**

```bash
git commit -m "feat: add defaultAssignee to org settings"
```

---

### Task 3: Assignment inheritance helper

**Files:**
- Create: `lib/assignment.ts`

**Step 1: Create the inheritance resolver**

Create `lib/assignment.ts`:

```typescript
import { db } from "@/lib/db";
import { clients, projects, organizations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { OrgFeatures } from "@/lib/db/schema";

/**
 * Resolve the default assignee for a new entity by walking up the ownership chain.
 * Returns the first non-null assignedTo found, or null if nobody is assigned.
 */
export async function resolveAssignee(opts: {
  explicit?: string | null;
  projectId?: string | null;
  clientId?: string | null;
  orgId: string;
}): Promise<string | null> {
  // Explicit assignment always wins
  if (opts.explicit) return opts.explicit;

  // Walk up: project → client → org default
  if (opts.projectId) {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, opts.projectId),
      columns: { assignedTo: true, clientId: true },
    });
    if (project?.assignedTo) return project.assignedTo;
    // Fall through to client
    if (project?.clientId) {
      const client = await db.query.clients.findFirst({
        where: eq(clients.id, project.clientId),
        columns: { assignedTo: true },
      });
      if (client?.assignedTo) return client.assignedTo;
    }
  } else if (opts.clientId) {
    const client = await db.query.clients.findFirst({
      where: eq(clients.id, opts.clientId),
      columns: { assignedTo: true },
    });
    if (client?.assignedTo) return client.assignedTo;
  }

  // Org default
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, opts.orgId),
    columns: { features: true },
  });
  const features = org?.features as OrgFeatures | null;
  return features?.defaultAssignee ?? null;
}
```

**Step 2: Verify**

Run: `pnpm typecheck`

**Step 3: Commit**

```bash
git add lib/assignment.ts
git commit -m "feat: add assignment inheritance resolver"
```

---

### Task 4: Wire inheritance into entity creation

**Files:**
- Modify: `app/api/v1/organizations/[orgId]/clients/route.ts` (POST)
- Modify: `app/api/v1/organizations/[orgId]/projects/route.ts` (POST)
- Modify: `app/api/v1/organizations/[orgId]/projects/[projectId]/tasks/route.ts` (POST)
- Modify: `app/api/webhooks/mailpace-inbound/route.ts`

**Step 1: Client creation**

In the client POST handler, after parsing the request body, resolve the assignee:

```typescript
import { resolveAssignee } from "@/lib/assignment";

// Before the insert:
const assignedTo = await resolveAssignee({
  explicit: body.assignedTo,
  orgId,
});
```

Add `assignedTo` to the insert values object.

**Step 2: Project creation**

In the project POST handler, resolve the assignee:

```typescript
import { resolveAssignee } from "@/lib/assignment";

const assignedTo = await resolveAssignee({
  explicit: body.assignedTo,
  clientId,
  orgId,
});
```

Add `assignedTo` to the insert values object.

**Step 3: Task creation**

In the task POST handler, if `assignedTo` is not explicitly provided in the body, resolve it:

```typescript
import { resolveAssignee } from "@/lib/assignment";

// Only resolve if not explicitly set (tasks already support assignedTo)
const assignedTo = body.assignedTo ?? await resolveAssignee({
  projectId,
  orgId,
});
```

Ensure the insert uses this resolved value.

**Step 4: Inbox item creation**

In the mailpace webhook handler, after resolving the entity, resolve the assignee:

```typescript
import { resolveAssignee } from "@/lib/assignment";

const assignedTo = await resolveAssignee({
  projectId: entity.type === "project" ? entity.id : undefined,
  clientId: entity.type === "client" ? entity.id : entity.clientId,
  orgId: entity.orgId,
});

// Add to inboxValues:
inboxValues.assignedTo = assignedTo;
```

**Step 5: Verify**

Run: `pnpm typecheck`
Test manually:
1. Set a default assignee in org settings
2. Create a new client — verify `assignedTo` is set
3. Create a new project under that client — verify `assignedTo` inherited
4. Create a new task in that project — verify `assignedTo` inherited

**Step 6: Commit**

```bash
git commit -m "feat: wire assignment inheritance into entity creation"
```

---

### Task 5: Client ownership UI

**Files:**
- Modify: `components/clients/client-detail-edit.tsx` (form field)
- Modify: `components/clients/client-detail-view.tsx` (display)
- Modify: `app/api/v1/organizations/[orgId]/clients/[clientId]/route.ts` (PATCH)

**Step 1: Add assignedTo to client PATCH API**

In the client PATCH handler, accept `assignedTo` from the request body and include it in the update object:

```typescript
if ("assignedTo" in body) {
  updates.assignedTo = body.assignedTo || null;
}
```

**Step 2: Add assignee selector to client edit form**

In `client-detail-edit.tsx`:
- Add `assignedTo` to the Zod schema (optional string, nullable)
- Fetch org members on mount (same pattern as task-detail-edit.tsx)
- Add a Select field labeled "Owner" after the existing form fields
- Use the member selector pattern: "Unassigned" option + list of members

**Step 3: Show assignee in client detail view**

In `client-detail-view.tsx`, add a row showing the assigned owner (name or "Unassigned"). Use the same layout pattern as other detail view fields.

**Step 4: Verify**

Run: `pnpm typecheck`
Test manually: edit a client, assign an owner, save, view detail — owner displays correctly.

**Step 5: Commit**

```bash
git commit -m "feat: add owner/assignee to client edit and detail view"
```

---

### Task 6: Project ownership UI

**Files:**
- Modify: `components/projects/project-detail-edit.tsx` (form field)
- Modify: `components/projects/project-detail-view.tsx` (display)
- Modify: `app/api/v1/organizations/[orgId]/projects/[projectId]/route.ts` (PATCH)

**Step 1: Add assignedTo to project PATCH API**

In the project PATCH handler, accept `assignedTo` from the request body and include it in the update object:

```typescript
if ("assignedTo" in body) {
  updates.assignedTo = body.assignedTo || null;
}
```

**Step 2: Add assignee selector to project edit form**

In `project-detail-edit.tsx`:
- Add `assignedTo` to the Zod schema (optional string, nullable)
- Fetch org members on mount (may already be available if task assignment uses the same data)
- Add a Select field labeled "Owner" — place it after the client selector
- Use the existing member selector pattern

**Step 3: Show assignee in project detail view**

In `project-detail-view.tsx`, add a row showing the assigned owner.

**Step 4: Verify**

Run: `pnpm typecheck`
Test manually: edit a project, assign an owner, save, view — owner displays. Create a new task in the project — verify task inherits the project owner as assignee.

**Step 5: Commit**

```bash
git commit -m "feat: add owner/assignee to project edit and detail view"
```

---

### Task 7: Task dueDate UI

**Files:**
- Modify: `components/projects/task-detail-edit.tsx` (form field)
- Modify: `components/projects/task-detail-view.tsx` (display)
- Modify: `app/api/v1/organizations/[orgId]/projects/[projectId]/tasks/route.ts` (POST)
- Modify: `app/api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/route.ts` (PATCH)

**Step 1: Accept dueDate in task POST and PATCH APIs**

In both the POST and PATCH handlers, accept `dueDate` from the request body and include it in the insert/update values.

**Step 2: Add dueDate to task edit form**

In `task-detail-edit.tsx`:
- Add `dueDate` to the Zod schema (optional string, nullable)
- Add a date input field. Use a `Popover` + `Calendar` component (from shadcn/ui) with `mode="single"` — matching the existing date picker pattern in the codebase (see `components/reports/date-range-picker.tsx` for reference).
- Place it after the estimate field.
- Label: "Due date"

**Step 3: Show dueDate in task detail view**

In `task-detail-view.tsx`, add a row showing the due date (formatted). If past due and task not done, show in a warning color.

**Step 4: Verify**

Run: `pnpm typecheck`
Test manually: edit a task, set a due date, save, view — due date displays. Set a past date on an open task — verify warning styling.

**Step 5: Commit**

```bash
git commit -m "feat: add dueDate to task edit and detail view"
```

---

### Task 8: Single-user auto-assign

**Files:**
- Modify: Onboarding/org creation flow (find the org creation handler)
- Modify: `lib/assignment.ts` (optional utility)

**Step 1: Find where orgs are created**

Check the onboarding flow and org creation API. When an org is created with a single member, auto-set `defaultAssignee` in the org's features JSON to that user's ID.

**Step 2: Implement auto-set**

After org creation (or after the first member is added), check the member count. If there's exactly one member, set `features.defaultAssignee` to that member's user ID.

**Step 3: Verify**

Test manually: create a new org through onboarding — verify `defaultAssignee` is set. Create a client — verify it inherits the assignee.

**Step 4: Commit**

```bash
git commit -m "feat: auto-set defaultAssignee for single-user orgs"
```

---

### Task 9: Second member nudge

**Files:**
- Modify: Team/invitation acceptance flow

**Step 1: Find where members are added**

Check the invitation acceptance flow and the add member API.

**Step 2: Add nudge logic**

When a second member is added to an org (member count goes from 1 to 2), check if `defaultAssignee` is set. If so, create a notification or surface a banner:

"You recently added a team member, but all new items are currently assigned to you. Update assignment defaults in Settings or on individual clients and projects."

This could be:
- A toast notification shown to the org owner
- A dismissible banner on the settings page
- A record in a `notifications` table (if one exists)

Use the simplest approach available — likely a toast or banner.

**Step 3: Commit**

```bash
git commit -m "feat: nudge when second member added to org"
```

---

### Task 10: Bulk reassignment API

**Files:**
- Create: `app/api/v1/organizations/[orgId]/members/[userId]/reassign/route.ts`

**Step 1: Create the endpoint**

```typescript
// POST /api/v1/organizations/{orgId}/members/{userId}/reassign
// Body: { newAssignee: string | null, entityTypes: ("tasks" | "projects" | "clients")[] }
```

Implementation:
- Verify the requesting user is an admin/owner
- For each entity type in `entityTypes`:
  - `"tasks"`: `UPDATE tasks SET assigned_to = newAssignee WHERE assigned_to = userId AND project_id IN (projects for this org)`
  - `"projects"`: `UPDATE projects SET assigned_to = newAssignee WHERE assigned_to = userId AND client_id IN (clients for this org)`
  - `"clients"`: `UPDATE clients SET assigned_to = newAssignee WHERE assigned_to = userId AND organization_id = orgId`
- Return counts of updated entities per type

**Step 2: Verify**

Run: `pnpm typecheck`
Test manually: assign several entities to a user, then bulk reassign — verify all specified types are updated.

**Step 3: Commit**

```bash
git commit -m "feat: add bulk reassignment API endpoint"
```

---

### Task 11: Bulk reassignment UI

**Files:**
- Modify: Team/members settings page (find the team management UI)

**Step 1: Add reassignment action**

On the team/members page, add a "Reassign items" action for each member. This opens a dialog showing:
- The member being reassigned from
- Checkboxes for entity types: Tasks, Projects, Clients
- A member selector for the new assignee (or "Unassign")
- Counts of how many entities of each type are currently assigned
- A confirm button

**Step 2: Wire to API**

On confirm, call `POST /api/v1/organizations/{orgId}/members/{userId}/reassign` with the selected entity types and new assignee.

**Step 3: Verify**

Test manually: open team page, click reassign on a member, select types and new assignee, confirm — verify entities are reassigned.

**Step 4: Commit**

```bash
git commit -m "feat: add bulk reassignment UI to team settings"
```

---

### Task 12: Update app/marketing docs

**Files:**
- Check `docs/product/APP_BRIEF.md` and any other product docs
- Update to reflect:
  - Entity ownership (clients, projects have owners)
  - Assignment inheritance
  - Due dates on tasks
  - Inbox item assignment
  - Default assignee org setting
  - Bulk reassignment

**Step 1: Update docs**

Review existing product/marketing documentation and update to capture:
- The ownership model (who's responsible for what)
- How assignment inheritance works for teams
- Single-user auto-assignment
- Due dates on tasks
- Bulk reassignment capability

**Step 2: Commit**

```bash
git commit -m "docs: update product docs for entity ownership and assignment"
```
