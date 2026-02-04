import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timeEntries } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import {
  resolveEntryBillable,
  getTaskWithChainForOrg,
} from "@/lib/entries/resolve-billable";

type RouteParams = {
  params: Promise<{ orgId: string; entryId: string }>;
};

/**
 * Shape an entry with its relations into the response format.
 */
function shapeEntryResponse(entry: {
  id: string;
  description: string | null;
  date: string;
  durationMinutes: number;
  isBillableOverride: boolean | null;
  createdAt: Date;
  task: {
    id: string;
    name: string;
    isBillable: boolean | null;
    project: {
      id: string;
      name: string;
      code: string | null;
      isBillable: boolean | null;
      client: {
        id: string;
        name: string;
        color: string | null;
        isBillable: boolean | null;
      };
    };
  };
}) {
  const isBillable = resolveEntryBillable({
    isBillableOverride: entry.isBillableOverride,
    task: {
      isBillable: entry.task.isBillable,
      project: {
        isBillable: entry.task.project.isBillable,
        client: {
          isBillable: entry.task.project.client.isBillable,
        },
      },
    },
  });

  return {
    id: entry.id,
    description: entry.description,
    date: entry.date,
    durationMinutes: entry.durationMinutes,
    isBillableOverride: entry.isBillableOverride,
    isBillable,
    createdAt: entry.createdAt.toISOString(),
    task: {
      id: entry.task.id,
      name: entry.task.name,
      project: {
        id: entry.task.project.id,
        name: entry.task.project.name,
        code: entry.task.project.code,
        client: {
          id: entry.task.project.client.id,
          name: entry.task.project.client.name,
          color: entry.task.project.client.color,
        },
      },
    },
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
      task: {
        with: {
          project: {
            with: {
              client: true,
            },
          },
        },
      },
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
        createdAt: entry.createdAt,
        task: {
          id: entry.task.id,
          name: entry.task.name,
          isBillable: entry.task.isBillable,
          project: {
            id: entry.task.project.id,
            name: entry.task.project.name,
            code: entry.task.project.code,
            isBillable: entry.task.project.isBillable,
            client: {
              id: entry.task.project.client.id,
              name: entry.task.project.client.name,
              color: entry.task.project.client.color,
              isBillable: entry.task.project.client.isBillable,
            },
          },
        },
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
    const { taskId, description, date, durationMinutes, isBillableOverride } =
      body;

    // Build update object with only provided fields
    const updates: Partial<{
      taskId: string;
      description: string | null;
      date: string;
      durationMinutes: number;
      isBillableOverride: boolean | null;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    // If changing task, verify new task belongs to this org
    if (taskId !== undefined && taskId !== existingEntry.taskId) {
      const newTask = await getTaskWithChainForOrg(taskId, orgId);

      if (!newTask) {
        return NextResponse.json(
          { error: "Task not found or does not belong to organization" },
          { status: 404 }
        );
      }
      updates.taskId = taskId;
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

    await db
      .update(timeEntries)
      .set(updates)
      .where(
        and(eq(timeEntries.id, entryId), eq(timeEntries.organizationId, orgId))
      );

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
        createdAt: updatedEntry.createdAt,
        task: {
          id: updatedEntry.task.id,
          name: updatedEntry.task.name,
          isBillable: updatedEntry.task.isBillable,
          project: {
            id: updatedEntry.task.project.id,
            name: updatedEntry.task.project.name,
            code: updatedEntry.task.project.code,
            isBillable: updatedEntry.task.project.isBillable,
            client: {
              id: updatedEntry.task.project.client.id,
              name: updatedEntry.task.project.client.name,
              color: updatedEntry.task.project.client.color,
              isBillable: updatedEntry.task.project.client.isBillable,
            },
          },
        },
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

    await db
      .delete(timeEntries)
      .where(
        and(eq(timeEntries.id, entryId), eq(timeEntries.organizationId, orgId))
      );

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
