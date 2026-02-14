# Inbox Hierarchy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface inbox items on project and client dashboards with scoped filtering, and support downward reassignment through the entity hierarchy.

**Architecture:** Add `clientId`, `projectId`, and `limit` query params to the inbox list API. Extend the inbox item PATCH to accept scope reassignment (down-only). Create a shared `EntityInboxSection` component for both project and client dashboards. Update the transfer form with scope-aware conditional rendering.

**Tech Stack:** Next.js App Router, Drizzle ORM, React, shadcn/ui (Card, Collapsible), sonner toasts.

**Design doc:** `docs/plans/2026-02-14-inbox-hierarchy-design.md`

---

### Task 1: Add filtering to inbox list API

**Files:**
- Modify: `app/api/v1/organizations/[orgId]/inbox/route.ts`

**Step 1: Add imports for trickle-up query**

Add `inArray` to the existing drizzle-orm import, and import `projects` from schema:

```typescript
import { eq, and, desc, inArray } from "drizzle-orm";
```

Add `projects` to the schema import (add to the existing import from `@/lib/db/schema`):

```typescript
import { inboxItems, INBOX_ITEM_STATUSES, type InboxItemStatus, projects } from "@/lib/db/schema";
```

**Step 2: Add query param parsing after the existing `status` param (line 23)**

After line 23 (`const status = searchParams.get("status");`), add:

```typescript
const clientId = searchParams.get("clientId");
const projectId = searchParams.get("projectId");
const limitParam = searchParams.get("limit");
const limit = limitParam ? parseInt(limitParam, 10) : undefined;
```

**Step 3: Add filtering conditions after the status condition (line 29)**

After the `if (status ...)` block, add:

```typescript
if (projectId) {
  whereConditions.push(eq(inboxItems.projectId, projectId));
} else if (clientId) {
  // Trickle-up: items scoped to the client OR any of its projects
  const clientProjects = await db.query.projects.findMany({
    where: eq(projects.clientId, clientId),
    columns: { id: true },
  });
  const projectIds = clientProjects.map((p) => p.id);

  if (projectIds.length > 0) {
    whereConditions.push(
      or(
        eq(inboxItems.clientId, clientId),
        inArray(inboxItems.projectId, projectIds)
      )!
    );
  } else {
    whereConditions.push(eq(inboxItems.clientId, clientId));
  }
}
```

Add `or` to the drizzle-orm import:

```typescript
import { eq, and, desc, inArray, or } from "drizzle-orm";
```

**Step 4: Add limit to the query**

Change the `findMany` call (line 31) to include a `limit` option:

```typescript
const items = await db.query.inboxItems.findMany({
  where: and(...whereConditions),
  orderBy: [desc(inboxItems.receivedAt)],
  limit: limit,
  with: {
    // ... existing relations unchanged
  },
});
```

**Step 5: Fix needsReviewCount for filtered views**

The current `needsReviewCount` filters the in-memory array, which works fine when status is filtered but undercounts when `limit` is applied. For dashboard badge accuracy, compute the count separately when a limit is used:

After the items query, replace the existing `needsReviewCount` line (line 53-55) with:

```typescript
// When limit is applied, the filtered count from items may be incomplete
// Always compute from the full filtered result for badge accuracy
let needsReviewCount: number;
if (limit) {
  const countItems = await db.query.inboxItems.findMany({
    where: and(
      ...whereConditions.filter((c) => c !== undefined),
      eq(inboxItems.status, "needs_review" as InboxItemStatus)
    ),
    columns: { id: true },
  });
  needsReviewCount = countItems.length;
} else {
  needsReviewCount = items.filter((i) => i.status === "needs_review").length;
}
```

**Step 6: Verify with typecheck**

Run: `pnpm typecheck`

**Step 7: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/inbox/route.ts
git commit -m "feat: add clientId, projectId, and limit params to inbox list API"
```

---

### Task 2: Extend inbox item PATCH for reassignment

**Files:**
- Modify: `app/api/v1/organizations/[orgId]/inbox/[itemId]/route.ts`

**Step 1: Add projects import**

Add `projects` to the schema import:

```typescript
import { inboxItems, INBOX_ITEM_STATUSES, type InboxItemStatus, projects } from "@/lib/db/schema";
```

**Step 2: Rewrite the PATCH handler to support both status and scope changes**

Replace the PATCH handler (lines 56-106) with:

```typescript
// PATCH /api/v1/organizations/[orgId]/inbox/[itemId]
// Update status and/or reassign scope (down-only)
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, itemId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { status, clientId, projectId } = body;

    // Verify item exists and belongs to this org
    const existing = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    // Status update
    if (status) {
      if (!INBOX_ITEM_STATUSES.includes(status as InboxItemStatus)) {
        return NextResponse.json(
          { error: "Invalid status. Must be one of: " + INBOX_ITEM_STATUSES.join(", ") },
          { status: 400 }
        );
      }
      updates.status = status;
    }

    // Scope reassignment (down-only)
    if (projectId) {
      // Verify project exists and belongs to this org
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        with: { client: { columns: { id: true, organizationId: true } } },
      });

      if (!project || project.client.organizationId !== orgId) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }

      // Down-only: can't reassign if already has a project
      if (existing.projectId && existing.projectId !== projectId) {
        return NextResponse.json(
          { error: "Item already scoped to a project. Cannot reassign laterally." },
          { status: 400 }
        );
      }

      updates.projectId = projectId;
      updates.clientId = project.clientId; // Auto-set from project's parent
    } else if (clientId) {
      // Down-only: can't set client if already has a project
      if (existing.projectId) {
        return NextResponse.json(
          { error: "Item already scoped to a project. Cannot widen scope." },
          { status: 400 }
        );
      }
      // Can't reassign if already has a different client
      if (existing.clientId && existing.clientId !== clientId) {
        return NextResponse.json(
          { error: "Item already scoped to a client. Cannot reassign laterally." },
          { status: 400 }
        );
      }
      updates.clientId = clientId;
    }

    // Must have at least one update
    if (Object.keys(updates).length === 1) {
      // Only updatedAt — nothing meaningful to change
      return NextResponse.json(
        { error: "No valid fields to update" },
        { status: 400 }
      );
    }

    const [updated] = await db
      .update(inboxItems)
      .set(updates)
      .where(eq(inboxItems.id, itemId))
      .returning();

    return NextResponse.json({ item: updated });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error updating inbox item:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 3: Verify with typecheck**

Run: `pnpm typecheck`

**Step 4: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/inbox/\[itemId\]/route.ts
git commit -m "feat: extend inbox PATCH for down-only scope reassignment"
```

---

### Task 3: Create EntityInboxSection component

**Files:**
- Create: `components/inbox/entity-inbox-section.tsx`

**Step 1: Create the component**

```tsx
"use client";

import { useEffect, useState } from "react";
import { Inbox, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import type { InboxItem } from "./types";

type EntityInboxSectionProps = {
  orgId: string;
  entityType: "project" | "client";
  entityId: string;
  entityName: string;
};

export function EntityInboxSection({
  orgId,
  entityType,
  entityId,
  entityName,
}: EntityInboxSectionProps) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    async function fetchItems() {
      try {
        const param = entityType === "project" ? "projectId" : "clientId";
        const res = await fetch(
          `/api/v1/organizations/${orgId}/inbox?${param}=${entityId}&status=needs_review&limit=5`
        );
        if (res.ok) {
          const data = await res.json();
          setItems(data.items);
          setCount(data.needsReviewCount);
          // Auto-open if there are items needing review
          if (data.needsReviewCount > 0) {
            setOpen(true);
          }
        }
      } catch {
        // Non-blocking — inbox failure shouldn't break the dashboard
      } finally {
        setLoading(false);
      }
    }
    fetchItems();
  }, [orgId, entityType, entityId]);

  if (loading) return null;
  if (count === 0 && items.length === 0) return null;

  const filterParam = entityType === "project" ? "projectId" : "clientId";
  const viewAllHref = `/inbox?${filterParam}=${entityId}`;

  return (
    <Card className="squircle">
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            {open ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
            <Inbox className="size-5" />
            Inbox
            {count > 0 && (
              <Badge variant="secondary" className="ml-1">
                {count}
              </Badge>
            )}
          </CardTitle>
          <Link
            href={viewAllHref}
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            View all
            <ExternalLink className="size-3" />
          </Link>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="pt-0">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No items need review.
            </p>
          ) : (
            <div className="space-y-2">
              {items.map((item) => (
                <Link
                  key={item.id}
                  href={`/inbox?item=${item.id}`}
                  className="flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-medium truncate">
                      {item.subject || "(no subject)"}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {item.fromName || item.fromAddress || "Unknown sender"}
                      {entityType === "client" && item.project && (
                        <> &middot; {item.project.name}</>
                      )}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0 ml-3">
                    {formatDistanceToNow(new Date(item.receivedAt), {
                      addSuffix: true,
                    })}
                  </span>
                </Link>
              ))}
              {count > items.length && (
                <Link
                  href={viewAllHref}
                  className="block text-center text-xs text-muted-foreground hover:text-foreground py-1"
                >
                  +{count - items.length} more
                </Link>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
```

**Step 2: Verify with typecheck**

Run: `pnpm typecheck`

**Step 3: Commit**

```bash
git add components/inbox/entity-inbox-section.tsx
git commit -m "feat: add EntityInboxSection component for dashboard embeds"
```

---

### Task 4: Add EntityInboxSection to project dashboard

**Files:**
- Modify: `app/(app)/projects/[id]/project-dashboard.tsx`

**Step 1: Add import**

Add to the imports at the top of the file:

```typescript
import { EntityInboxSection } from "@/components/inbox/entity-inbox-section";
```

**Step 2: Render the section**

Find the `ProjectExpenses` section (around line 807-810). After it, add:

```tsx
{/* Inbox */}
{capabilities.expenses && (
  <EntityInboxSection
    orgId={orgId}
    entityType="project"
    entityId={project.id}
    entityName={project.name}
  />
)}
```

Note: Check the `capabilities` object — `capabilities.expenses` gates expense-related features. If a different gate is more appropriate (like checking `features.expenses` directly), use that instead. The subagent should look at what's available in scope.

**Step 3: Verify with typecheck**

Run: `pnpm typecheck`

**Step 4: Commit**

```bash
git add app/\(app\)/projects/\[id\]/project-dashboard.tsx
git commit -m "feat: add inbox section to project dashboard"
```

---

### Task 5: Add EntityInboxSection to client dashboard

**Files:**
- Modify: `app/(app)/clients/[id]/client-dashboard.tsx`

**Step 1: Add import**

Add to the imports at the top of the file:

```typescript
import { EntityInboxSection } from "@/components/inbox/entity-inbox-section";
```

**Step 2: Render the section**

Find the `ClientFiles` section (around line 523). After it and before the email intake settings section (line ~525), add:

```tsx
{/* Inbox */}
<EntityInboxSection
  orgId={orgId}
  entityType="client"
  entityId={client.id}
  entityName={client.name}
/>
```

Note: Check if there's a feature gate for expenses/inbox on the client dashboard. If the project dashboard uses `capabilities.expenses`, find the equivalent here. If no explicit gate exists, rendering unconditionally is fine — the component returns null when there are no items.

**Step 3: Verify with typecheck**

Run: `pnpm typecheck`

**Step 4: Commit**

```bash
git add app/\(app\)/clients/\[id\]/client-dashboard.tsx
git commit -m "feat: add inbox section to client dashboard"
```

---

### Task 6: Update transfer form for scope-aware reassignment

**Files:**
- Modify: `components/inbox/inbox-transfer-form.tsx`

**Step 1: Rewrite the component with conditional scope rendering**

Replace the entire file with:

```tsx
"use client";

import { useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ProjectSelector } from "@/components/expenses/project-selector";
import { toast } from "sonner";
import type { InboxItem } from "./types";

type InboxTransferFormProps = {
  orgId: string;
  item: InboxItem;
  onConverted: () => void;
  onCancel: () => void;
};

export function InboxTransferForm({
  orgId,
  item,
  onConverted,
  onCancel,
}: InboxTransferFormProps) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Item already at most specific scope — can't transfer further down
  if (item.projectId) {
    return (
      <div className="space-y-4 rounded-md border p-4">
        <h3 className="text-sm font-medium">Transfer Item</h3>
        <p className="text-sm text-muted-foreground">
          This item is already scoped to a project and cannot be transferred
          further.
        </p>
        <div className="flex items-center justify-end pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!projectId) {
      toast.error("Select a project to transfer to");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/inbox/${item.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to transfer");
      }

      toast.success("Item transferred");
      onConverted();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to transfer item"
      );
    } finally {
      setSubmitting(false);
    }
  }

  // Has client but no project — show project selector filtered to this client
  // No scope at all — show project selector (picking a project auto-sets client)
  const description = item.clientId
    ? "Assign this item to a specific project under this client."
    : "Assign this item to a project. The client will be set automatically.";

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
      <h3 className="text-sm font-medium">Transfer Item</h3>

      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">{description}</p>

        <div className="space-y-1.5">
          <Label>Project</Label>
          <ProjectSelector
            orgId={orgId}
            selectedProjectId={projectId}
            onSelect={setProjectId}
            open={projectSelectorOpen}
            onOpenChange={setProjectSelectorOpen}
            clientId={item.clientId ?? undefined}
          >
            <Button
              variant="outline"
              role="combobox"
              className="w-full justify-between font-normal"
              type="button"
            >
              {projectId ? "Project selected" : "Select a project"}
              <ChevronDown className="ml-2 size-4 opacity-50" />
            </Button>
          </ProjectSelector>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !projectId}>
          {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
          Transfer
        </Button>
      </div>
    </form>
  );
}
```

**Important:** This passes `clientId` to `ProjectSelector` to filter projects when the item already has a client scope. Check if `ProjectSelector` accepts a `clientId` prop for filtering. If it doesn't, omit that prop — the user can still pick from all projects, and the API auto-sets the correct client.

**Step 2: Verify with typecheck**

Run: `pnpm typecheck`

**Step 3: Commit**

```bash
git add components/inbox/inbox-transfer-form.tsx
git commit -m "feat: update transfer form with scope-aware conditional rendering"
```

---

### Task 7: Final verification

**Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 2: Run lint**

Run: `pnpm lint`
Expected: PASS or only pre-existing warnings

**Step 3: Manual test checklist**

1. Visit `/inbox` — existing behavior unchanged, all org items visible
2. Visit `/inbox?projectId=<id>` — only items for that project appear
3. Visit `/inbox?clientId=<id>` — items for that client + its projects appear (trickle-up)
4. Open a project dashboard — inbox section appears if items exist, collapsed if empty
5. Open a client dashboard — inbox section appears with trickle-up items
6. Click an item in the dashboard section — navigates to `/inbox?item=<id>` and opens detail
7. Click "View all" link — navigates to `/inbox?projectId=<id>` or `/inbox?clientId=<id>`
8. Open inbox detail → Transfer on an org-level item — shows project selector
9. Open inbox detail → Transfer on a client-scoped item — shows project selector filtered to that client
10. Open inbox detail → Transfer on a project-scoped item — shows "already scoped" message
