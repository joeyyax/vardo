import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tasks, taskTypes, projects, projectFiles, taskFiles } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { uploadBuffer, isR2Configured } from "@/lib/r2";
import { nanoid } from "nanoid";
import { eq, and, desc, sql } from "drizzle-orm";

type ScreenshotInput = {
  dataUrl: string;
  selectionRect: { x: number; y: number; width: number; height: number };
  expandedRect: { x: number; y: number; width: number; height: number };
  scrollOffset?: { x: number; y: number };
};

function getClientIp(request: NextRequest): string | undefined {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    undefined
  );
}

/** Convert a base64 data URL to a Buffer for server-side upload. */
function dataUrlToBuffer(dataUrl: string): Buffer | null {
  try {
    const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
    if (!match) return null;
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}

// POST /api/v1/bug-reports — create a bug task from the widget
export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    const body = await request.json();

    const {
      organizationId,
      projectId,
      scopeClientId,
      description,
      pageUrl,
      metadata,
      priority: rawPriority,
    } = body;

    const validPriorities = ["low", "medium", "high", "urgent"];
    const priority = validPriorities.includes(rawPriority) ? rawPriority : null;

    if (!description || typeof description !== "string" || description.trim().length === 0) {
      return NextResponse.json(
        { error: "Description is required" },
        { status: 400 }
      );
    }

    if (!organizationId) {
      return NextResponse.json(
        { error: "Organization ID is required" },
        { status: 400 }
      );
    }

    if (!projectId) {
      return NextResponse.json(
        { error: "Project ID is required" },
        { status: 400 }
      );
    }

    // Validate project exists and belongs to the org
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: { client: { columns: { organizationId: true } } },
    });

    if (!project?.client || project.client.organizationId !== organizationId) {
      return NextResponse.json(
        { error: "Invalid project" },
        { status: 400 }
      );
    }

    if (project.isArchived || project.stage === "completed" || project.stage === "offboarding") {
      return NextResponse.json(
        { error: "Project is no longer accepting bug reports" },
        { status: 400 }
      );
    }

    const screenshots: ScreenshotInput[] = body.screenshots || [];
    const ipAddress = getClientIp(request);

    // Upload screenshots to R2
    const screenshotMeta: Array<{
      r2Key: string;
      selectionRect: { x: number; y: number; width: number; height: number };
      expandedRect: { x: number; y: number; width: number; height: number };
      scrollOffset?: { x: number; y: number };
    }> = [];

    const uploadedFiles: Array<{ r2Key: string; buffer: Buffer; name: string }> = [];

    if (isR2Configured()) {
      for (const ss of screenshots) {
        const buffer = dataUrlToBuffer(ss.dataUrl);
        if (!buffer) continue;

        const r2Key = `bug-reports/${organizationId}/${nanoid(12)}.png`;
        try {
          await uploadBuffer(r2Key, buffer, "image/png");
          screenshotMeta.push({
            r2Key,
            selectionRect: ss.selectionRect,
            expandedRect: ss.expandedRect,
            scrollOffset: ss.scrollOffset,
          });
          uploadedFiles.push({
            r2Key,
            buffer,
            name: `bug-screenshot-${nanoid(6)}.png`,
          });
        } catch (err) {
          console.error("Error uploading screenshot to R2:", err);
        }
      }
    }

    // Build task metadata from widget context
    const taskMetadata: Record<string, unknown> = { source: "widget" };
    if (scopeClientId) taskMetadata.scopeClientId = scopeClientId;
    if (pageUrl) taskMetadata.pageUrl = pageUrl;
    if (metadata?.browser) taskMetadata.browser = metadata.browser;
    if (metadata?.browserVersion) taskMetadata.browserVersion = metadata.browserVersion;
    if (metadata?.os) taskMetadata.os = metadata.os;
    if (metadata?.viewport) taskMetadata.viewport = metadata.viewport;
    if (metadata?.env) taskMetadata.env = metadata.env;
    if (metadata?.referrer) taskMetadata.referrer = metadata.referrer;
    if (metadata?.userAgent) taskMetadata.userAgent = metadata.userAgent;
    if (ipAddress) taskMetadata.ipAddress = ipAddress;
    if (metadata?.cache) taskMetadata.cache = metadata.cache;
    if (metadata?.cookieNames) taskMetadata.cookieNames = metadata.cookieNames;
    if (metadata?.connection) taskMetadata.connection = metadata.connection;
    if (metadata?.documentReadyState) taskMetadata.documentReadyState = metadata.documentReadyState;
    if (metadata?.recentErrors) taskMetadata.recentErrors = metadata.recentErrors;
    if (metadata?.memory) taskMetadata.memory = metadata.memory;
    if (screenshotMeta.length > 0) taskMetadata.screenshots = screenshotMeta;

    // Create task (with file links) in a transaction
    const newTask = await db.transaction(async (tx) => {
      const bugType = await tx.query.taskTypes.findFirst({
        where: and(
          eq(taskTypes.organizationId, organizationId),
          sql`LOWER(${taskTypes.name}) = 'bug'`
        ),
      });

      const maxPosResult = await tx
        .select({ maxPos: sql<number>`COALESCE(MAX(position), 0)` })
        .from(tasks)
        .where(
          and(eq(tasks.projectId, projectId), eq(tasks.status, "todo"))
        );
      const nextPosition = (maxPosResult[0]?.maxPos ?? 0) + 1;

      const [task] = await tx.insert(tasks).values({
        projectId,
        name: `Bug: ${description.trim().slice(0, 100)}`,
        description: [
          description.trim(),
          pageUrl ? `\n\nPage: ${pageUrl}` : "",
        ].join(""),
        status: "todo",
        priority,
        createdBy: session.user.id,
        position: nextPosition,
        typeId: bugType?.id || null,
        metadata: taskMetadata,
      }).returning();

      // Link uploaded screenshots as project files + task files
      for (const uf of uploadedFiles) {
        const [file] = await tx.insert(projectFiles).values({
          projectId,
          uploadedBy: session.user.id,
          name: uf.name,
          sizeBytes: uf.buffer.byteLength,
          mimeType: "image/png",
          r2Key: uf.r2Key,
        }).returning();

        await tx.insert(taskFiles).values({
          taskId: task.id,
          fileId: file.id,
        });
      }

      return task;
    });

    // Return in the shape the widget expects
    return NextResponse.json(
      {
        report: {
          id: newTask.id,
          description: newTask.description || newTask.name,
          status: "new",
          pageUrl: pageUrl || null,
          priority: newTask.priority || null,
          createdAt: newTask.createdAt,
          updatedAt: newTask.updatedAt,
          commentCount: 0,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error creating bug report:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// Map task status to widget-friendly status
function mapTaskStatus(status: string | null): string {
  switch (status) {
    case "in_progress":
    case "review":
      return "reviewed";
    case "done":
      return "resolved";
    default:
      return "new";
  }
}

// GET /api/v1/bug-reports — list widget-submitted tasks for the widget
export async function GET(request: NextRequest) {
  try {
    await requireSession();

    const { searchParams } = new URL(request.url);
    const orgId = searchParams.get("organizationId");

    if (!orgId) {
      return NextResponse.json(
        { error: "organizationId is required" },
        { status: 400 }
      );
    }

    const projectId = searchParams.get("projectId");

    if (!projectId) {
      return NextResponse.json(
        { error: "projectId is required" },
        { status: 400 }
      );
    }

    // Fetch tasks submitted from the widget (source: "widget" or legacy bugReportId)
    const bugTasks = await db.query.tasks.findMany({
      where: and(
        eq(tasks.projectId, projectId),
        sql`(${tasks.metadata}->>'source' = 'widget' OR ${tasks.metadata}->>'bugReportId' IS NOT NULL)`
      ),
      orderBy: [desc(tasks.createdAt)],
      limit: 50,
      columns: {
        id: true,
        name: true,
        description: true,
        status: true,
        isArchived: true,
        createdAt: true,
        updatedAt: true,
        priority: true,
        metadata: true,
      },
      with: {
        createdByUser: { columns: { id: true, name: true, email: true } },
        assignedToUser: { columns: { id: true, name: true, email: true } },
        comments: { columns: { id: true } },
        project: { columns: { id: true, name: true } },
      },
    });

    // Map to the shape the widget expects
    const reports = bugTasks.map((task) => {
      const meta = (task.metadata ?? {}) as Record<string, unknown>;
      return {
        id: task.id,
        description: task.description || task.name,
        status: task.isArchived ? "dismissed" : mapTaskStatus(task.status),
        pageUrl: (meta.pageUrl as string) || null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        priority: task.priority || null,
        assignee: task.assignedToUser || undefined,
        commentCount: task.comments?.length ?? 0,
        reporter: task.createdByUser || undefined,
        project: task.project || undefined,
        metadata: meta,
      };
    });

    return NextResponse.json(reports);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching bug reports:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
