# Task Types & Tags Settings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add inline management UI for task types and task tags on the settings page, with the missing CRUD API endpoints.

**Architecture:** Two new client components (`task-types-settings.tsx`, `task-tags-settings.tsx`) rendered inline on the settings page, gated behind `features.pm`. Three new API route files for individual PATCH/DELETE on types and tags, plus a reorder endpoint for types. Uses `@dnd-kit` (already installed) for drag-to-reorder types.

**Tech Stack:** Next.js App Router, React, Tailwind CSS, shadcn/ui, Drizzle ORM, @dnd-kit/core + @dnd-kit/sortable, sonner toasts.

**Design doc:** `docs/plans/2026-02-12-task-types-tags-settings-design.md`

---

### Task 1: Task Types — Individual PATCH/DELETE API Route

**Files:**
- Create: `app/api/v1/organizations/[orgId]/task-types/[typeId]/route.ts`

**Context:**
- Existing list route: `app/api/v1/organizations/[orgId]/task-types/route.ts`
- Follow the pattern in `app/api/v1/organizations/[orgId]/clients/[clientId]/contacts/[contactId]/route.ts`
- Schema: `taskTypes` table with columns: id, organizationId, name, color, icon, defaultFields, position, isArchived, createdAt
- The `tasks.typeId` references `taskTypes.id` with `onDelete: "set null"` — so deleting a type won't break tasks, it just nulls their typeId

**Step 1: Create the route file**

```typescript
// app/api/v1/organizations/[orgId]/task-types/[typeId]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { taskTypes } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; typeId: string }>;
};

// PATCH /api/v1/organizations/[orgId]/task-types/[typeId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, typeId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const existing = await db.query.taskTypes.findFirst({
      where: and(
        eq(taskTypes.id, typeId),
        eq(taskTypes.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Task type not found" }, { status: 404 });
    }

    const body = await request.json();
    const { name, color, position, isArchived } = body;

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name.trim();
    if (color !== undefined) updates.color = color || null;
    if (position !== undefined) updates.position = position;
    if (isArchived !== undefined) updates.isArchived = isArchived;

    const [updated] = await db
      .update(taskTypes)
      .set(updates)
      .where(eq(taskTypes.id, typeId))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating task type:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/task-types/[typeId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, typeId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const existing = await db.query.taskTypes.findFirst({
      where: and(
        eq(taskTypes.id, typeId),
        eq(taskTypes.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Task type not found" }, { status: 404 });
    }

    // Schema has onDelete: "set null" on tasks.typeId, so this is safe
    await db.delete(taskTypes).where(eq(taskTypes.id, typeId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting task type:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 2: Verify with typecheck**

Run: `pnpm typecheck`
Expected: No new errors

**Step 3: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/task-types/\[typeId\]/route.ts
git commit -m "feat: add PATCH/DELETE endpoints for task types"
```

---

### Task 2: Task Types — Reorder API Route

**Files:**
- Create: `app/api/v1/organizations/[orgId]/task-types/reorder/route.ts`

**Step 1: Create the reorder route**

```typescript
// app/api/v1/organizations/[orgId]/task-types/reorder/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { taskTypes } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// PATCH /api/v1/organizations/[orgId]/task-types/reorder
// Body: { order: [{ id: string, position: number }] }
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { order } = body;

    if (!Array.isArray(order) || order.length === 0) {
      return NextResponse.json({ error: "order array is required" }, { status: 400 });
    }

    // Update positions in a transaction
    await db.transaction(async (tx) => {
      for (const item of order) {
        await tx
          .update(taskTypes)
          .set({ position: item.position })
          .where(eq(taskTypes.id, item.id));
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error reordering task types:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 2: Verify with typecheck**

Run: `pnpm typecheck`
Expected: No new errors

**Step 3: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/task-types/reorder/route.ts
git commit -m "feat: add reorder endpoint for task types"
```

---

### Task 3: Task Tags — Individual PATCH/DELETE API Route

**Files:**
- Create: `app/api/v1/organizations/[orgId]/task-tags/[tagId]/route.ts`

**Context:**
- Schema: `taskTags` table with columns: id, organizationId, name, color, isPredefined, createdAt
- `taskTagAssignments` has `onDelete: "cascade"` on tagId — deleting a tag cascades to all assignments

**Step 1: Create the route file**

```typescript
// app/api/v1/organizations/[orgId]/task-tags/[tagId]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { taskTags } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; tagId: string }>;
};

// PATCH /api/v1/organizations/[orgId]/task-tags/[tagId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, tagId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const existing = await db.query.taskTags.findFirst({
      where: and(
        eq(taskTags.id, tagId),
        eq(taskTags.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Task tag not found" }, { status: 404 });
    }

    const body = await request.json();
    const { name, color, isPredefined } = body;

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name.trim();
    if (color !== undefined) updates.color = color || null;
    if (isPredefined !== undefined) updates.isPredefined = isPredefined;

    const [updated] = await db
      .update(taskTags)
      .set(updates)
      .where(eq(taskTags.id, tagId))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating task tag:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/task-tags/[tagId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, tagId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const existing = await db.query.taskTags.findFirst({
      where: and(
        eq(taskTags.id, tagId),
        eq(taskTags.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Task tag not found" }, { status: 404 });
    }

    // Schema has onDelete: "cascade" on taskTagAssignments.tagId
    await db.delete(taskTags).where(eq(taskTags.id, tagId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting task tag:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 2: Verify with typecheck**

Run: `pnpm typecheck`
Expected: No new errors

**Step 3: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/task-tags/\[tagId\]/route.ts
git commit -m "feat: add PATCH/DELETE endpoints for task tags"
```

---

### Task 4: Task Types Settings Component

**Files:**
- Create: `app/(app)/settings/task-types-settings.tsx`

**Context:**
- Color palette: reuse `PRESET_COLORS` from `components/clients/client-detail-edit.tsx` (extract to shared const or duplicate — small array, duplication is fine)
- DnD pattern: `@dnd-kit/core` + `@dnd-kit/sortable` already installed, used in `app/(app)/clients/clients-content.tsx`
- Settings section pattern: Card with CardHeader (title + description) + CardContent, like `notification-preferences.tsx`
- Component is `"use client"`, fetches from `/api/v1/organizations/${orgId}/task-types`
- Receives `orgId` as prop from settings page

**Step 1: Create the component**

Build `task-types-settings.tsx` with:
- Fetch task types on mount
- Sortable list using `@dnd-kit/sortable` with `SortableContext` + `verticalListSortingStrategy`
- Each row: drag handle (`GripVertical`), color dot, name, edit button (`Pencil`), archive/unarchive button (`Archive`/`ArchiveRestore`)
- "Show archived" toggle (checkbox or button) — hidden by default
- "Add Type" button opens a Dialog with: name input, color palette (clickable circles), Save/Cancel
- Edit button opens same Dialog pre-filled
- Drag end updates positions optimistically + calls PATCH reorder endpoint
- Archive/unarchive calls PATCH on individual type with `isArchived` toggle
- Toast on success/error

**Key UI details:**
- Color picker: row of 10 preset color circles (same as client colors), clicking selects
- Archived rows: dimmed text + strikethrough, archive icon changes to restore icon
- Empty state: "No task types yet. Add types to categorize tasks."

**Step 2: Verify with typecheck**

Run: `pnpm typecheck`
Expected: No new errors

**Step 3: Commit**

```bash
git add app/\(app\)/settings/task-types-settings.tsx
git commit -m "feat: add task types management component for settings"
```

---

### Task 5: Task Tags Settings Component

**Files:**
- Create: `app/(app)/settings/task-tags-settings.tsx`

**Context:**
- Simpler than task types — no drag-and-drop, no position ordering
- Same color palette, same Dialog pattern for add/edit
- Shows `isPredefined` status: ad-hoc tags get a subtle "ad-hoc" badge
- Delete with confirmation dialog (AlertDialog from shadcn)

**Step 1: Create the component**

Build `task-tags-settings.tsx` with:
- Fetch task tags on mount
- List of rows: color dot, name, "ad-hoc" badge (if `isPredefined === false`), edit button, delete button
- "Add Tag" button opens Dialog with: name input, color palette, Save/Cancel
- Edit Dialog pre-filled; if tag is ad-hoc, show option to promote to predefined
- Delete button shows AlertDialog confirmation: "Delete tag? This will remove it from all tasks."
- Toast on success/error

**Key UI details:**
- Ad-hoc badge: small muted text `(ad-hoc)` next to name
- Empty state: "No task tags yet. Add tags to label and filter tasks."

**Step 2: Verify with typecheck**

Run: `pnpm typecheck`
Expected: No new errors

**Step 3: Commit**

```bash
git add app/\(app\)/settings/task-tags-settings.tsx
git commit -m "feat: add task tags management component for settings"
```

---

### Task 6: Wire Components into Settings Page

**Files:**
- Modify: `app/(app)/settings/page.tsx`

**Context:**
- Insert new section between FeaturesForm and Document Templates section
- Gate behind `features.pm`
- Pass `orgId={organization.id}` to both components

**Step 1: Add imports and render section**

In `app/(app)/settings/page.tsx`:
- Import `TaskTypesSettings` and `TaskTagsSettings`
- After the `FeaturesForm` section and before the Document Templates section, add:

```tsx
{/* Task Configuration - only show if PM is enabled */}
{features.pm && (
  <div className="space-y-6">
    <div>
      <h2 className="text-lg font-medium">Tasks</h2>
      <p className="text-sm text-muted-foreground">
        Configure task types and tags for your organization.
      </p>
    </div>
    <TaskTypesSettings orgId={organization.id} />
    <TaskTagsSettings orgId={organization.id} />
  </div>
)}
```

**Step 2: Verify with typecheck**

Run: `pnpm typecheck`
Expected: No new errors

**Step 3: Test manually**

- Open settings page with PM feature enabled
- Verify "Tasks" section appears between Features and Document Templates
- Add a task type, verify it appears in the list
- Drag to reorder, verify positions persist on reload
- Archive a type, verify it hides (and shows with toggle)
- Add a tag, edit it, delete it
- Verify the task dialog still shows types/tags correctly

**Step 4: Commit**

```bash
git add app/\(app\)/settings/page.tsx
git commit -m "feat: wire task types and tags settings into settings page"
```

---

### Task 7: Update PLATFORM_EXPANSION.md

**Files:**
- Modify: `docs/PLATFORM_EXPANSION.md`

**Step 1: Mark Phase 10 items as complete**

Update the Phase 10 section to check off task type management and task tag management. If all 4 items are now done, mark Phase 10 as complete.

**Step 2: Commit**

```bash
git add docs/PLATFORM_EXPANSION.md
git commit -m "docs: mark Phase 10 task types/tags as complete"
```
