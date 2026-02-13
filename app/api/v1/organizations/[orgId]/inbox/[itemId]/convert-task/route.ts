import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  inboxItems,
  tasks,
  projectFiles,
  taskComments,
  projects,
} from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; itemId: string }>;
};

// POST /api/v1/organizations/[orgId]/inbox/[itemId]/convert-task
// Convert an inbox item into a new task or attach to an existing task
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

    // Fetch the inbox item with files
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
      return NextResponse.json(
        { error: "Item has already been converted" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { mode } = body;

    if (mode === "new") {
      return handleNewTask(orgId, itemId, item, body, session.user.id);
    } else if (mode === "attach") {
      return handleAttachTask(orgId, itemId, item, body, session.user.id);
    } else {
      return NextResponse.json(
        { error: "Mode must be 'new' or 'attach'" },
        { status: 400 }
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error converting inbox item to task:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

type InboxItem = {
  id: string;
  projectId: string | null;
  files: { name: string; sizeBytes: number; mimeType: string; r2Key: string }[];
};

async function handleNewTask(
  orgId: string,
  itemId: string,
  item: InboxItem,
  body: { name?: string; description?: string; projectId?: string },
  userId: string
) {
  const { name, description } = body;
  const resolvedProjectId = body.projectId || item.projectId;

  if (!resolvedProjectId) {
    return NextResponse.json(
      { error: "A project is required for task creation" },
      { status: 400 }
    );
  }

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json(
      { error: "Task name is required" },
      { status: 400 }
    );
  }

  // Verify the project belongs to this org
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, resolvedProjectId),
    with: {
      client: { columns: { organizationId: true } },
    },
  });

  if (!project || project.client.organizationId !== orgId) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Create the task
  const [task] = await db
    .insert(tasks)
    .values({
      projectId: resolvedProjectId,
      name: name.trim(),
      description: description?.trim() || null,
      status: "todo",
      createdBy: userId,
    })
    .returning();

  // If item has files, create project file records
  let files: typeof projectFiles.$inferSelect[] = [];
  if (item.files && item.files.length > 0) {
    files = await db
      .insert(projectFiles)
      .values(
        item.files.map((file) => ({
          projectId: resolvedProjectId,
          uploadedBy: userId,
          name: file.name,
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType,
          r2Key: file.r2Key,
          tags: ["inbox", "task"],
        }))
      )
      .returning();
  }

  // Mark inbox item as converted
  await db
    .update(inboxItems)
    .set({
      status: "converted",
      convertedTo: "task",
      updatedAt: new Date(),
    })
    .where(eq(inboxItems.id, itemId));

  return NextResponse.json(
    { task, files, item: { id: itemId, status: "converted" } },
    { status: 201 }
  );
}

async function handleAttachTask(
  orgId: string,
  itemId: string,
  item: InboxItem,
  body: { taskId?: string; content?: string },
  userId: string
) {
  const { taskId, content } = body;

  if (!taskId) {
    return NextResponse.json(
      { error: "Task ID is required" },
      { status: 400 }
    );
  }

  // Verify the task exists and belongs to this org
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

  // If item has files, create project file records for the task's project
  let files: typeof projectFiles.$inferSelect[] = [];
  if (item.files && item.files.length > 0) {
    files = await db
      .insert(projectFiles)
      .values(
        item.files.map((file) => ({
          projectId: task.projectId,
          uploadedBy: userId,
          name: file.name,
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType,
          r2Key: file.r2Key,
          tags: ["inbox", "task"],
        }))
      )
      .returning();
  }

  // If content provided, add a comment to the task
  let comment;
  if (content && typeof content === "string" && content.trim()) {
    [comment] = await db
      .insert(taskComments)
      .values({
        taskId,
        authorId: userId,
        content: content.trim(),
      })
      .returning();
  }

  // Mark inbox item as converted
  await db
    .update(inboxItems)
    .set({
      status: "converted",
      convertedTo: "task",
      updatedAt: new Date(),
    })
    .where(eq(inboxItems.id, itemId));

  return NextResponse.json(
    { task, files, comment, item: { id: itemId, status: "converted" } },
    { status: 201 }
  );
}
