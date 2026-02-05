import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timeEntries } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import {
  resolveEntryBillable,
  validateEntryHierarchy,
} from "@/lib/entries/resolve-billable";
import { updateRollingDraftInvoice } from "@/lib/invoices/rolling-draft";

type RouteParams = {
  params: Promise<{ orgId: string; entryId: string }>;
};

/**
 * Shape an entry with its relations into the response format.
 * Handles entries at any level: client, project, or task.
 */
function shapeEntryResponse(entry: {
  id: string;
  description: string | null;
  date: string;
  durationMinutes: number;
  isBillableOverride: boolean | null;
  recurringTemplateId?: string | null;
  createdAt: Date;
  client: {
    id: string;
    name: string;
    color: string | null;
    isBillable: boolean | null;
  };
  project?: {
    id: string;
    name: string;
    code: string | null;
    isBillable: boolean | null;
  } | null;
  task?: {
    id: string;
    name: string;
    isBillable: boolean | null;
  } | null;
}) {
  const isBillable = resolveEntryBillable({
    isBillableOverride: entry.isBillableOverride,
    task: entry.task ? { isBillable: entry.task.isBillable } : null,
    project: entry.project ? { isBillable: entry.project.isBillable } : null,
    client: { isBillable: entry.client.isBillable },
  });

  return {
    id: entry.id,
    description: entry.description,
    date: entry.date,
    durationMinutes: entry.durationMinutes,
    isBillableOverride: entry.isBillableOverride,
    isBillable,
    recurringTemplateId: entry.recurringTemplateId || null,
    createdAt: entry.createdAt.toISOString(),
    client: {
      id: entry.client.id,
      name: entry.client.name,
      color: entry.client.color,
    },
    project: entry.project
      ? {
          id: entry.project.id,
          name: entry.project.name,
          code: entry.project.code,
        }
      : null,
    task: entry.task
      ? {
          id: entry.task.id,
          name: entry.task.name,
        }
      : null,
  };
}

/**
 * Get an entry that belongs to the specified organization.
 * Returns the entry with full relations if valid, null otherwise.
 */
async function getEntryForOrg(entryId: string, orgId: string) {
  const entry = await db.query.timeEntries.findFirst({
    where: and(
      eq(timeEntries.id, entryId),
      eq(timeEntries.organizationId, orgId)
    ),
    with: {
      client: true,
      project: true,
      task: true,
    },
  });

  return entry || null;
}

// GET /api/v1/organizations/[orgId]/entries/[entryId]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entryId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const entry = await getEntryForOrg(entryId, orgId);

    if (!entry) {
      return NextResponse.json({ error: "Entry not found" }, { status: 404 });
    }

    return NextResponse.json(
      shapeEntryResponse({
        id: entry.id,
        description: entry.description,
        date: entry.date,
        durationMinutes: entry.durationMinutes,
        isBillableOverride: entry.isBillableOverride,
        recurringTemplateId: entry.recurringTemplateId,
        createdAt: entry.createdAt,
        client: {
          id: entry.client.id,
          name: entry.client.name,
          color: entry.client.color,
          isBillable: entry.client.isBillable,
        },
        project: entry.project
          ? {
              id: entry.project.id,
              name: entry.project.name,
              code: entry.project.code,
              isBillable: entry.project.isBillable,
            }
          : null,
        task: entry.task
          ? {
              id: entry.task.id,
              name: entry.task.name,
              isBillable: entry.task.isBillable,
            }
          : null,
      })
    );
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
    console.error("Error fetching entry:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH /api/v1/organizations/[orgId]/entries/[entryId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entryId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify entry exists and belongs to org
    const existingEntry = await getEntryForOrg(entryId, orgId);
    if (!existingEntry) {
      return NextResponse.json({ error: "Entry not found" }, { status: 404 });
    }

    const body = await request.json();
    const {
      clientId,
      projectId,
      taskId,
      description,
      date,
      durationMinutes,
      isBillableOverride,
      recurringTemplateId,
    } = body;

    // Build update object with only provided fields
    const updates: Partial<{
      clientId: string;
      projectId: string | null;
      taskId: string | null;
      description: string | null;
      date: string;
      durationMinutes: number;
      isBillableOverride: boolean | null;
      recurringTemplateId: string | null;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    // If changing hierarchy, validate it
    const newClientId = clientId ?? existingEntry.clientId;
    const newProjectId =
      projectId !== undefined ? projectId : existingEntry.projectId;
    const newTaskId = taskId !== undefined ? taskId : existingEntry.taskId;

    // Check if hierarchy is changing
    const hierarchyChanging =
      clientId !== undefined ||
      projectId !== undefined ||
      taskId !== undefined;

    if (hierarchyChanging) {
      const validation = await validateEntryHierarchy(
        orgId,
        newClientId,
        newProjectId,
        newTaskId
      );

      if (!validation.valid) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
      }

      if (clientId !== undefined) updates.clientId = clientId;
      if (projectId !== undefined) updates.projectId = projectId || null;
      if (taskId !== undefined) updates.taskId = taskId || null;
    }

    if (description !== undefined) {
      updates.description = description?.trim() || null;
    }

    if (date !== undefined) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(date)) {
        return NextResponse.json(
          { error: "date must be in YYYY-MM-DD format" },
          { status: 400 }
        );
      }
      updates.date = date;
    }

    if (durationMinutes !== undefined) {
      const duration = parseInt(String(durationMinutes), 10);
      if (isNaN(duration) || duration <= 0) {
        return NextResponse.json(
          { error: "durationMinutes must be a positive integer" },
          { status: 400 }
        );
      }
      updates.durationMinutes = duration;
    }

    if (isBillableOverride !== undefined) {
      updates.isBillableOverride = isBillableOverride;
    }

    if (recurringTemplateId !== undefined) {
      updates.recurringTemplateId = recurringTemplateId;
    }

    await db
      .update(timeEntries)
      .set(updates)
      .where(
        and(eq(timeEntries.id, entryId), eq(timeEntries.organizationId, orgId))
      );

    // Update rolling draft invoices for affected clients (non-blocking)
    const clientsToUpdate = new Set([existingEntry.clientId]);
    if (clientId && clientId !== existingEntry.clientId) {
      clientsToUpdate.add(clientId);
    }
    for (const cid of clientsToUpdate) {
      updateRollingDraftInvoice(orgId, cid).catch((err) => {
        console.error("Error updating rolling draft invoice:", err);
      });
    }

    // Fetch updated entry with relations
    const updatedEntry = await getEntryForOrg(entryId, orgId);

    if (!updatedEntry) {
      return NextResponse.json({ error: "Entry not found" }, { status: 404 });
    }

    return NextResponse.json(
      shapeEntryResponse({
        id: updatedEntry.id,
        description: updatedEntry.description,
        date: updatedEntry.date,
        durationMinutes: updatedEntry.durationMinutes,
        isBillableOverride: updatedEntry.isBillableOverride,
        recurringTemplateId: updatedEntry.recurringTemplateId,
        createdAt: updatedEntry.createdAt,
        client: {
          id: updatedEntry.client.id,
          name: updatedEntry.client.name,
          color: updatedEntry.client.color,
          isBillable: updatedEntry.client.isBillable,
        },
        project: updatedEntry.project
          ? {
              id: updatedEntry.project.id,
              name: updatedEntry.project.name,
              code: updatedEntry.project.code,
              isBillable: updatedEntry.project.isBillable,
            }
          : null,
        task: updatedEntry.task
          ? {
              id: updatedEntry.task.id,
              name: updatedEntry.task.name,
              isBillable: updatedEntry.task.isBillable,
            }
          : null,
      })
    );
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
    console.error("Error updating entry:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/v1/organizations/[orgId]/entries/[entryId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entryId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify entry exists and belongs to org
    const existingEntry = await getEntryForOrg(entryId, orgId);
    if (!existingEntry) {
      return NextResponse.json({ error: "Entry not found" }, { status: 404 });
    }

    const clientId = existingEntry.clientId;

    await db
      .delete(timeEntries)
      .where(
        and(eq(timeEntries.id, entryId), eq(timeEntries.organizationId, orgId))
      );

    // Update rolling draft invoice for affected client (non-blocking)
    updateRollingDraftInvoice(orgId, clientId).catch((err) => {
      console.error("Error updating rolling draft invoice:", err);
    });

    return NextResponse.json({ success: true });
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
    console.error("Error deleting entry:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
