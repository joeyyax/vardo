# Global Discussions & Entity Email Actions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface discussions as a slide-over panel on project/client dashboards, and expand inbox email conversions to support file, discussion, task (new + attach), expense, and transfer actions.

**Architecture:** Reuse existing `Sheet` + `EntityComments` for the discussions panel (no new APIs). For email conversions, add a `convertedTo` column to inbox_items and create per-type conversion API endpoints + form components.

**Tech Stack:** Next.js App Router, Drizzle ORM, shadcn/ui (Sheet, Select), React, TypeScript

---

### Task 1: Add `convertedTo` column to inbox_items schema

**Files:**
- Modify: `lib/db/schema.ts`

**Step 1: Add the column**

In `lib/db/schema.ts`, find the `inboxItems` table definition (line ~1340). Add a `convertedTo` column after `convertedExpenseId`:

```typescript
convertedTo: text("converted_to").$type<"expense" | "file" | "discussion" | "task" | "transfer">(),
```

**Step 2: Push schema**

Run: `pnpm db:push`

If Drizzle Kit's interactive TUI blocks, apply via direct SQL:

```bash
docker compose exec -T postgres psql -U time -d time -c "ALTER TABLE inbox_items ADD COLUMN converted_to TEXT;"
```

**Step 3: Update InboxItem type**

In `components/inbox/types.ts`, add to the `InboxItem` type:

```typescript
convertedTo: "expense" | "file" | "discussion" | "task" | "transfer" | null;
```

**Step 4: Update the existing convert (expense) endpoint**

In `app/api/v1/organizations/[orgId]/inbox/[itemId]/convert/route.ts`, find the section that marks the inbox item as converted (line ~123). Add `convertedTo: "expense"` to the update:

```typescript
await db
  .update(inboxItems)
  .set({
    status: "converted",
    convertedExpenseId: expense.id,
    convertedTo: "expense",
    updatedAt: new Date(),
  })
  .where(eq(inboxItems.id, itemId));
```

**Step 5: Verify**

Run: `pnpm typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add lib/db/schema.ts components/inbox/types.ts app/api/v1/organizations/*/inbox/*/convert/route.ts
git commit -m "feat: add convertedTo column to inbox_items"
```

---

### Task 2: Create the DiscussionSheet component

**Files:**
- Create: `components/ui/discussion-sheet.tsx`

**Step 1: Create the component**

Create `components/ui/discussion-sheet.tsx`:

```tsx
"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ProjectComments } from "@/components/projects/project-comments";
import { ClientComments } from "@/components/clients/client-comments";

type DiscussionSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: "project" | "client";
  entityId: string;
  entityName: string;
  orgId: string;
  currentUserId: string;
  onUpdate?: () => void;
};

export function DiscussionSheet({
  open,
  onOpenChange,
  entityType,
  entityId,
  entityName,
  orgId,
  currentUserId,
  onUpdate,
}: DiscussionSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-md w-full flex flex-col"
        showCloseButton
      >
        <SheetHeader>
          <SheetTitle>Discussion</SheetTitle>
          <SheetDescription>{entityName}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 min-h-0 overflow-hidden">
          {entityType === "project" ? (
            <ProjectComments
              orgId={orgId}
              projectId={entityId}
              currentUserId={currentUserId}
              onUpdate={onUpdate}
            />
          ) : (
            <ClientComments
              orgId={orgId}
              clientId={entityId}
              currentUserId={currentUserId}
              onUpdate={onUpdate}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

**Step 2: Verify**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add components/ui/discussion-sheet.tsx
git commit -m "feat: create DiscussionSheet component"
```

---

### Task 3: Add Discussions button to project dashboard

**Files:**
- Modify: `app/(app)/projects/[id]/project-dashboard.tsx`

**Step 1: Add imports and state**

Add `MessageSquare` to the lucide-react import (line ~8). Add import for `DiscussionSheet`:

```typescript
import { DiscussionSheet } from "@/components/ui/discussion-sheet";
```

Add `MessageSquare` to the existing lucide-react destructure:

```typescript
import { ..., MessageSquare } from "lucide-react";
```

In the `ProjectDashboard` component, add state (near the other useState calls around line 175):

```typescript
const [discussionOpen, setDiscussionOpen] = useState(false);
```

**Step 2: Add the button to the action bar**

Find the action buttons section (line ~313, the `<div className="flex items-center gap-3">`). Add the Discussions button before the existing buttons:

```tsx
<Button
  variant="outline"
  onClick={() => setDiscussionOpen(true)}
  className="squircle"
>
  <MessageSquare className="size-4" />
  Discussion
</Button>
```

**Step 3: Render the DiscussionSheet**

At the bottom of the component's return, before the closing `</div>`, add:

```tsx
<DiscussionSheet
  open={discussionOpen}
  onOpenChange={setDiscussionOpen}
  entityType="project"
  entityId={project.id}
  entityName={project.name}
  orgId={orgId}
  currentUserId={currentUserId || ""}
/>
```

**Step 4: Verify**

Run: `pnpm typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add app/\(app\)/projects/\[id\]/project-dashboard.tsx
git commit -m "feat: add discussions slide-over to project dashboard"
```

---

### Task 4: Add Discussions button to client dashboard

**Files:**
- Modify: `app/(app)/clients/[id]/page.tsx`
- Modify: `app/(app)/clients/[id]/client-dashboard.tsx`

**Step 1: Pass currentUserId from page.tsx to ClientDashboard**

The client page.tsx (unlike project) does not fetch the session or pass `currentUserId`. Update it:

In `app/(app)/clients/[id]/page.tsx`, add `getSession` to the auth import:

```typescript
import { getCurrentOrg, getSession } from "@/lib/auth/session";
```

Change the data fetch to also get the session:

```typescript
const [orgData, session] = await Promise.all([getCurrentOrg(), getSession()]);

if (!orgData || !session?.user?.id) {
  redirect("/onboarding");
}
```

Pass `currentUserId` to ClientDashboard:

```tsx
<ClientDashboard
  client={client}
  orgId={orgData.organization.id}
  currentUserId={session.user.id}
/>
```

**Step 2: Update ClientDashboard to accept and use currentUserId**

In `app/(app)/clients/[id]/client-dashboard.tsx`:

Add `MessageSquare` to the lucide-react import. Add import:

```typescript
import { DiscussionSheet } from "@/components/ui/discussion-sheet";
```

Find `ClientDashboardProps` type (look for the props definition). Add `currentUserId: string` to it.

Add to the function signature destructure: `currentUserId`.

Add state:

```typescript
const [discussionOpen, setDiscussionOpen] = useState(false);
```

**Step 3: Add the button to the client action bar**

Find the action buttons section (line ~246, `<div className="flex items-center gap-3">`). Add before `ClientInvitations`:

```tsx
<Button
  variant="outline"
  onClick={() => setDiscussionOpen(true)}
  className="squircle"
>
  <MessageSquare className="size-4" />
  Discussion
</Button>
```

**Step 4: Render DiscussionSheet**

At the bottom of the component's return, before the closing tag:

```tsx
<DiscussionSheet
  open={discussionOpen}
  onOpenChange={setDiscussionOpen}
  entityType="client"
  entityId={client.id}
  entityName={client.name}
  orgId={orgId}
  currentUserId={currentUserId}
/>
```

**Step 5: Verify**

Run: `pnpm typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add app/\(app\)/clients/\[id\]/page.tsx app/\(app\)/clients/\[id\]/client-dashboard.tsx
git commit -m "feat: add discussions slide-over to client dashboard"
```

---

### Task 5: Create convert-file API endpoint

**Files:**
- Create: `app/api/v1/organizations/[orgId]/inbox/[itemId]/convert-file/route.ts`

**Step 1: Create the endpoint**

This endpoint takes an inbox item's files and creates `projectFiles` records for them on the associated project. If the item has a `clientId` but no `projectId`, files cannot be linked to a project — return an error asking to specify a project.

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { inboxItems, inboxItemFiles, projectFiles } from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; itemId: string }>;
};

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, itemId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const item = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.organizationId, orgId)
      ),
      with: { files: true },
    });

    if (!item) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (item.status === "converted") {
      return NextResponse.json({ error: "Already converted" }, { status: 400 });
    }

    // Require a projectId — files are stored per-project
    const body = await request.json().catch(() => ({}));
    const projectId = body.projectId || item.projectId;
    if (!projectId) {
      return NextResponse.json(
        { error: "A project is required to save files" },
        { status: 400 }
      );
    }

    if (!item.files.length) {
      return NextResponse.json(
        { error: "No files to convert" },
        { status: 400 }
      );
    }

    // Create projectFiles records for each inbox file
    const created = await db
      .insert(projectFiles)
      .values(
        item.files.map((f) => ({
          projectId,
          uploadedBy: session.user.id,
          name: f.name,
          sizeBytes: f.sizeBytes,
          mimeType: f.mimeType,
          r2Key: f.r2Key,
          tags: ["inbox"],
        }))
      )
      .returning();

    // Mark as converted
    await db
      .update(inboxItems)
      .set({
        status: "converted",
        convertedTo: "file",
        updatedAt: new Date(),
      })
      .where(eq(inboxItems.id, itemId));

    return NextResponse.json(
      { files: created, item: { id: itemId, status: "converted" } },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error converting inbox item to files:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 2: Verify**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/inbox/\[itemId\]/convert-file/route.ts
git commit -m "feat: add convert-to-file API for inbox items"
```

---

### Task 6: Create convert-discussion API endpoint

**Files:**
- Create: `app/api/v1/organizations/[orgId]/inbox/[itemId]/convert-discussion/route.ts`

**Step 1: Create the endpoint**

This endpoint creates a comment on the associated project or client from the email content.

Look at how the existing comment API creates comments. The pattern is: insert into the entity's comments table (e.g., `projectComments` or `clientComments`). Check the schema for these table names:

```bash
grep -n "export const projectComments\|export const clientComments" lib/db/schema.ts
```

The endpoint should:
1. Accept `{ content: string, entityType?: "project" | "client", entityId?: string }`
2. Default to the item's `projectId` or `clientId` if not provided
3. Insert into `projectComments` or `clientComments` table
4. Mark inbox item as converted with `convertedTo: "discussion"`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { inboxItems, projectComments, clientComments } from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; itemId: string }>;
};

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, itemId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const item = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.organizationId, orgId)
      ),
    });

    if (!item) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (item.status === "converted") {
      return NextResponse.json({ error: "Already converted" }, { status: 400 });
    }

    const body = await request.json();
    const { content } = body;

    if (!content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }

    // Determine target entity
    const targetProjectId = body.projectId || item.projectId;
    const targetClientId = body.clientId || item.clientId;

    let comment;

    if (targetProjectId) {
      [comment] = await db
        .insert(projectComments)
        .values({
          projectId: targetProjectId,
          userId: session.user.id,
          content: content.trim(),
        })
        .returning();
    } else if (targetClientId) {
      [comment] = await db
        .insert(clientComments)
        .values({
          clientId: targetClientId,
          userId: session.user.id,
          content: content.trim(),
        })
        .returning();
    } else {
      return NextResponse.json(
        { error: "A project or client is required" },
        { status: 400 }
      );
    }

    // Mark as converted
    await db
      .update(inboxItems)
      .set({
        status: "converted",
        convertedTo: "discussion",
        updatedAt: new Date(),
      })
      .where(eq(inboxItems.id, itemId));

    return NextResponse.json(
      { comment, item: { id: itemId, status: "converted" } },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error converting inbox item to discussion:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 2: Verify**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/inbox/\[itemId\]/convert-discussion/route.ts
git commit -m "feat: add convert-to-discussion API for inbox items"
```

---

### Task 7: Create convert-task API endpoint

**Files:**
- Create: `app/api/v1/organizations/[orgId]/inbox/[itemId]/convert-task/route.ts`

**Step 1: Create the endpoint**

Supports two modes: create a new task, or attach files to an existing task.

Body: `{ mode: "new" | "attach", name?: string, description?: string, projectId?: string, taskId?: string }`

For "new": creates a task in the `tasks` table. The task schema (line 554 of schema.ts) requires `projectId` and `name`.

For "attach": takes an existing `taskId`, creates `projectFiles` records tagged with `["inbox", "task"]` for the inbox item's files, and optionally adds a comment to the task with the email content.

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  inboxItems,
  tasks,
  projectFiles,
  taskComments,
} from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; itemId: string }>;
};

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, itemId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const item = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.organizationId, orgId)
      ),
      with: { files: true },
    });

    if (!item) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (item.status === "converted") {
      return NextResponse.json({ error: "Already converted" }, { status: 400 });
    }

    const body = await request.json();
    const { mode } = body;

    if (mode === "new") {
      const { name, description } = body;
      const projectId = body.projectId || item.projectId;

      if (!projectId) {
        return NextResponse.json(
          { error: "A project is required to create a task" },
          { status: 400 }
        );
      }
      if (!name || typeof name !== "string" || !name.trim()) {
        return NextResponse.json(
          { error: "Task name is required" },
          { status: 400 }
        );
      }

      const [task] = await db
        .insert(tasks)
        .values({
          projectId,
          name: name.trim(),
          description: description?.trim() || null,
          status: "todo",
          createdBy: session.user.id,
        })
        .returning();

      // Also link any files to the project
      if (item.files.length) {
        await db.insert(projectFiles).values(
          item.files.map((f) => ({
            projectId,
            uploadedBy: session.user.id,
            name: f.name,
            sizeBytes: f.sizeBytes,
            mimeType: f.mimeType,
            r2Key: f.r2Key,
            tags: ["inbox", "task"],
          }))
        );
      }

      await db
        .update(inboxItems)
        .set({
          status: "converted",
          convertedTo: "task",
          updatedAt: new Date(),
        })
        .where(eq(inboxItems.id, itemId));

      return NextResponse.json(
        { task, item: { id: itemId, status: "converted" } },
        { status: 201 }
      );
    }

    if (mode === "attach") {
      const { taskId, content } = body;

      if (!taskId) {
        return NextResponse.json(
          { error: "taskId is required for attach mode" },
          { status: 400 }
        );
      }

      // Verify task exists and belongs to this org
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
        with: {
          project: {
            with: {
              client: { columns: { organizationId: true } },
            },
          },
        },
      });

      if (!task || task.project.client.organizationId !== orgId) {
        return NextResponse.json({ error: "Task not found" }, { status: 404 });
      }

      // Link files to the task's project
      if (item.files.length) {
        await db.insert(projectFiles).values(
          item.files.map((f) => ({
            projectId: task.projectId,
            uploadedBy: session.user.id,
            name: f.name,
            sizeBytes: f.sizeBytes,
            mimeType: f.mimeType,
            r2Key: f.r2Key,
            tags: ["inbox", "task"],
          }))
        );
      }

      // Optionally add a comment to the task
      if (content && typeof content === "string" && content.trim()) {
        await db.insert(taskComments).values({
          taskId,
          userId: session.user.id,
          content: content.trim(),
        });
      }

      await db
        .update(inboxItems)
        .set({
          status: "converted",
          convertedTo: "task",
          updatedAt: new Date(),
        })
        .where(eq(inboxItems.id, itemId));

      return NextResponse.json(
        { taskId, item: { id: itemId, status: "converted" } },
        { status: 201 }
      );
    }

    return NextResponse.json(
      { error: "mode must be 'new' or 'attach'" },
      { status: 400 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error converting inbox item to task:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 2: Verify**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/inbox/\[itemId\]/convert-task/route.ts
git commit -m "feat: add convert-to-task API for inbox items (new + attach)"
```

---

### Task 8: Create inbox conversion form components

**Files:**
- Create: `components/inbox/inbox-convert-file-form.tsx`
- Create: `components/inbox/inbox-convert-discussion-form.tsx`
- Create: `components/inbox/inbox-convert-task-form.tsx`
- Create: `components/inbox/inbox-transfer-form.tsx`

**Step 1: Create inbox-convert-file-form.tsx**

Simple confirmation form showing which files will be linked. Uses `ProjectSelector` if the item doesn't already have a project.

```tsx
"use client";

import { useState } from "react";
import { Loader2, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ProjectSelector } from "@/components/expenses/project-selector";
import { toast } from "sonner";
import type { InboxItem } from "./types";

type Props = {
  orgId: string;
  item: InboxItem;
  onConverted: () => void;
  onCancel: () => void;
};

export function InboxConvertFileForm({ orgId, item, onConverted, onCancel }: Props) {
  const [projectId, setProjectId] = useState<string | null>(item.projectId);
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      toast.error("Select a project to save files to");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/inbox/${item.id}/convert-file`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to convert");
      }
      onConverted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save files");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
      <h3 className="text-sm font-medium">Save as Project Files</h3>
      <p className="text-sm text-muted-foreground">
        {item.files.length} file{item.files.length !== 1 ? "s" : ""} will be added to the project.
      </p>

      <div className="space-y-1.5">
        <Label>Project</Label>
        <ProjectSelector
          orgId={orgId}
          selectedProjectId={projectId}
          onSelect={setProjectId}
          open={projectSelectorOpen}
          onOpenChange={setProjectSelectorOpen}
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

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
          Save Files
        </Button>
      </div>
    </form>
  );
}
```

**Step 2: Create inbox-convert-discussion-form.tsx**

```tsx
"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import type { InboxItem } from "./types";

type Props = {
  orgId: string;
  item: InboxItem;
  onConverted: () => void;
  onCancel: () => void;
};

export function InboxConvertDiscussionForm({ orgId, item, onConverted, onCancel }: Props) {
  const defaultContent = [
    item.subject ? `**${item.subject}**` : null,
    item.fromName || item.fromAddress
      ? `From: ${item.fromName || ""} ${item.fromAddress ? `<${item.fromAddress}>` : ""}`
      : null,
    "---",
    "(Email content forwarded from inbox)",
  ]
    .filter(Boolean)
    .join("\n\n");

  const [content, setContent] = useState(defaultContent);
  const [submitting, setSubmitting] = useState(false);

  const targetLabel = item.project?.name || item.client?.name || "entity";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) {
      toast.error("Content is required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/inbox/${item.id}/convert-discussion`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: content.trim() }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to convert");
      }
      onConverted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to post discussion");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
      <h3 className="text-sm font-medium">Post as Discussion</h3>
      <p className="text-sm text-muted-foreground">
        Post a comment on <span className="font-medium">{targetLabel}</span>.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="discussion-content">Comment</Label>
        <Textarea
          id="discussion-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
        />
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
          Post Comment
        </Button>
      </div>
    </form>
  );
}
```

**Step 3: Create inbox-convert-task-form.tsx**

Uses `TaskSelector` from `components/timeline/task-selector.tsx` for attach mode. Uses `ProjectSelector` for new task mode.

```tsx
"use client";

import { useState } from "react";
import { Loader2, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProjectSelector } from "@/components/expenses/project-selector";
import { TaskSelector } from "@/components/timeline/task-selector";
import { toast } from "sonner";
import type { InboxItem } from "./types";

type Props = {
  orgId: string;
  item: InboxItem;
  onConverted: () => void;
  onCancel: () => void;
};

export function InboxConvertTaskForm({ orgId, item, onConverted, onCancel }: Props) {
  const [mode, setMode] = useState<"new" | "attach">("new");
  const [name, setName] = useState(item.subject || "");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string | null>(item.projectId);
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskSelectorOpen, setTaskSelectorOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (mode === "new") {
      if (!name.trim()) {
        toast.error("Task name is required");
        return;
      }
      if (!projectId) {
        toast.error("Select a project");
        return;
      }
    } else {
      if (!taskId) {
        toast.error("Select a task");
        return;
      }
    }

    setSubmitting(true);
    try {
      const body =
        mode === "new"
          ? { mode: "new", name: name.trim(), description: description.trim() || null, projectId }
          : { mode: "attach", taskId, content: item.subject ? `Attached from email: ${item.subject}` : null };

      const res = await fetch(
        `/api/v1/organizations/${orgId}/inbox/${item.id}/convert-task`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to convert");
      }

      onConverted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
      <h3 className="text-sm font-medium">Convert to Task</h3>

      <div className="space-y-1.5">
        <Label>Mode</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as "new" | "attach")}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="new">Create new task</SelectItem>
            <SelectItem value="attach">Attach to existing task</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {mode === "new" ? (
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="task-name">Task name</Label>
            <Input
              id="task-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Task name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-description">Description</Label>
            <Textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Project</Label>
            <ProjectSelector
              orgId={orgId}
              selectedProjectId={projectId}
              onSelect={setProjectId}
              open={projectSelectorOpen}
              onOpenChange={setProjectSelectorOpen}
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
      ) : (
        <div className="space-y-1.5">
          <Label>Task</Label>
          <TaskSelector
            orgId={orgId}
            selectedTaskId={taskId}
            onSelect={setTaskId}
            open={taskSelectorOpen}
            onOpenChange={setTaskSelectorOpen}
          >
            <Button
              variant="outline"
              role="combobox"
              className="w-full justify-between font-normal"
              type="button"
            >
              {taskId ? "Task selected" : "Select a task"}
              <ChevronDown className="ml-2 size-4 opacity-50" />
            </Button>
          </TaskSelector>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
          {mode === "new" ? "Create Task" : "Attach to Task"}
        </Button>
      </div>
    </form>
  );
}
```

**Step 4: Create inbox-transfer-form.tsx**

```tsx
"use client";

import { useState } from "react";
import { Loader2, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ProjectSelector } from "@/components/expenses/project-selector";
import { toast } from "sonner";
import type { InboxItem } from "./types";

type Props = {
  orgId: string;
  item: InboxItem;
  onConverted: () => void;
  onCancel: () => void;
};

export function InboxTransferForm({ orgId, item, onConverted, onCancel }: Props) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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
      toast.error(err instanceof Error ? err.message : "Failed to transfer");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
      <h3 className="text-sm font-medium">Transfer to Another Project</h3>
      <p className="text-sm text-muted-foreground">
        Move this inbox item to a different project. It will remain in the inbox for further action.
      </p>

      <div className="space-y-1.5">
        <Label>Transfer to</Label>
        <ProjectSelector
          orgId={orgId}
          selectedProjectId={projectId}
          onSelect={setProjectId}
          open={projectSelectorOpen}
          onOpenChange={setProjectSelectorOpen}
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

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
          Transfer
        </Button>
      </div>
    </form>
  );
}
```

**Step 5: Verify**

Run: `pnpm typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add components/inbox/inbox-convert-file-form.tsx components/inbox/inbox-convert-discussion-form.tsx components/inbox/inbox-convert-task-form.tsx components/inbox/inbox-transfer-form.tsx
git commit -m "feat: add conversion form components for file, discussion, task, and transfer"
```

---

### Task 9: Update inbox-item-detail.tsx with conversion type selector

**Files:**
- Modify: `components/inbox/inbox-item-detail.tsx`

**Step 1: Add imports**

Add imports for the new form components and UI elements:

```typescript
import { InboxConvertFileForm } from "./inbox-convert-file-form";
import { InboxConvertDiscussionForm } from "./inbox-convert-discussion-form";
import { InboxConvertTaskForm } from "./inbox-convert-task-form";
import { InboxTransferForm } from "./inbox-transfer-form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
```

Add these icons to the existing lucide-react import: `MessageSquare, ListTodo, ArrowRightLeft, FolderOpen`.

**Step 2: Replace single convert button with conversion selector**

Replace the current `showConvertForm` state (line 42):

```typescript
const [convertType, setConvertType] = useState<string | null>(null);
```

Replace the `actions` section (line 98-118). Instead of the single `Receipt` icon button, add a `Select` dropdown for the conversion type:

```tsx
const isActionable = item.status === "needs_review";

const actions = isActionable ? (
  <>
    <IconButton
      icon={Info}
      tooltip="Mark Informational"
      onClick={() => updateStatus("informational")}
      disabled={updating}
    />
    <IconButton
      icon={Trash2}
      tooltip="Discard"
      onClick={() => updateStatus("discarded")}
      disabled={updating}
    />
  </>
) : null;
```

**Step 3: Add conversion selector and forms to the body**

Replace the convert form section at the bottom (lines 230-238) with:

```tsx
{/* Conversion actions */}
{isActionable && (
  <div className="space-y-3">
    <Select
      value={convertType || ""}
      onValueChange={(v) => setConvertType(v || null)}
    >
      <SelectTrigger>
        <SelectValue placeholder="Convert to..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="expense">
          <span className="flex items-center gap-2">
            <Receipt className="size-4" /> Expense
          </span>
        </SelectItem>
        <SelectItem value="file">
          <span className="flex items-center gap-2">
            <FolderOpen className="size-4" /> Project File
          </span>
        </SelectItem>
        <SelectItem value="discussion">
          <span className="flex items-center gap-2">
            <MessageSquare className="size-4" /> Discussion
          </span>
        </SelectItem>
        <SelectItem value="task">
          <span className="flex items-center gap-2">
            <ListTodo className="size-4" /> Task
          </span>
        </SelectItem>
        <SelectItem value="transfer">
          <span className="flex items-center gap-2">
            <ArrowRightLeft className="size-4" /> Transfer
          </span>
        </SelectItem>
      </SelectContent>
    </Select>

    {convertType === "expense" && (
      <InboxConvertForm
        orgId={orgId}
        item={item}
        onConverted={handleConverted}
        onCancel={() => setConvertType(null)}
      />
    )}
    {convertType === "file" && (
      <InboxConvertFileForm
        orgId={orgId}
        item={item}
        onConverted={handleConverted}
        onCancel={() => setConvertType(null)}
      />
    )}
    {convertType === "discussion" && (
      <InboxConvertDiscussionForm
        orgId={orgId}
        item={item}
        onConverted={handleConverted}
        onCancel={() => setConvertType(null)}
      />
    )}
    {convertType === "task" && (
      <InboxConvertTaskForm
        orgId={orgId}
        item={item}
        onConverted={handleConverted}
        onCancel={() => setConvertType(null)}
      />
    )}
    {convertType === "transfer" && (
      <InboxTransferForm
        orgId={orgId}
        item={item}
        onConverted={handleConverted}
        onCancel={() => setConvertType(null)}
      />
    )}
  </div>
)}
```

**Step 4: Update the converted status display**

Update the converted status section (line 201-209) to show what the item was converted to, not just expenses:

```tsx
{item.status === "converted" && (
  <div className="rounded-md border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/50 p-3">
    <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
      <CheckCircle2 className="size-4" />
      <span>
        {item.convertedTo === "expense" && item.convertedExpense
          ? `Converted to expense: ${item.convertedExpense.description}`
          : item.convertedTo === "file"
            ? "Files saved to project"
            : item.convertedTo === "discussion"
              ? "Posted as discussion"
              : item.convertedTo === "task"
                ? "Converted to task"
                : "Converted"}
      </span>
    </div>
  </div>
)}
```

**Step 5: Update the `handleConverted` function**

Update the toast message to be generic:

```typescript
function handleConverted() {
  setConvertType(null);
  onItemUpdated();
  onOpenChange(false);
  toast.success("Inbox item converted");
}
```

**Step 6: Verify**

Run: `pnpm typecheck`
Expected: PASS

**Step 7: Commit**

```bash
git add components/inbox/inbox-item-detail.tsx
git commit -m "feat: add conversion type selector to inbox item detail"
```

---

### Task 10: Update inbox list to show convertedTo status

**Files:**
- Modify: `components/inbox/inbox-content.tsx`

**Step 1: Update the converted badge**

Find where the status badges are rendered in the inbox list. When an item has `status === "converted"`, show what it was converted to:

```tsx
{item.status === "converted" && (
  <Badge variant="secondary" className="bg-green-100 text-green-700">
    {item.convertedTo
      ? `→ ${item.convertedTo.charAt(0).toUpperCase() + item.convertedTo.slice(1)}`
      : "Converted"}
  </Badge>
)}
```

**Step 2: Ensure the API returns convertedTo**

Check the inbox list API endpoint (`app/api/v1/organizations/[orgId]/inbox/route.ts`). If it doesn't already return `convertedTo`, add it to the select/query.

**Step 3: Verify**

Run: `pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add components/inbox/inbox-content.tsx
git commit -m "feat: show conversion type in inbox list badges"
```

---

### Task 11: Final verification

**Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS with no errors

**Step 2: Run lint**

Run: `pnpm lint`
Expected: PASS or only pre-existing warnings

**Step 3: Manual test checklist**

1. Open a project dashboard → click "Discussion" button → sheet slides in from right with comments + activities timeline → can post a comment → close sheet
2. Open a client dashboard → same pattern works
3. Open inbox → click an item → see "Convert to..." dropdown → select each type and verify the correct form appears
4. Convert to file → files appear in project files
5. Convert to discussion → comment appears on entity
6. Convert to task (new) → task is created
7. Convert to task (attach) → files linked, comment added to existing task
8. Convert to expense → existing behavior works
9. Transfer → item moves to new project, stays in inbox
10. Converted items show the correct badge in the list
