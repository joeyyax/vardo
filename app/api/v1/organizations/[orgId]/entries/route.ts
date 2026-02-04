import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timeEntries } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import {
  resolveEntryBillable,
  validateEntryHierarchy,
} from "@/lib/entries/resolve-billable";

type RouteParams = {
  params: Promise<{ orgId: string }>;
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

// GET /api/v1/organizations/[orgId]/entries
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, session } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const searchParams = request.nextUrl.searchParams;
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const clientId = searchParams.get("clientId");
    const projectId = searchParams.get("projectId");
    const userId = searchParams.get("userId") || session.user.id;

    // Validate required date range
    if (!from || !to) {
      return NextResponse.json(
        { error: "Both 'from' and 'to' date parameters are required" },
        { status: 400 }
      );
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(from) || !dateRegex.test(to)) {
      return NextResponse.json(
        { error: "Dates must be in YYYY-MM-DD format" },
        { status: 400 }
      );
    }

    // Query entries with all possible relations
    const entries = await db.query.timeEntries.findMany({
      where: and(
        eq(timeEntries.organizationId, orgId),
        eq(timeEntries.userId, userId),
        gte(timeEntries.date, from),
        lte(timeEntries.date, to)
      ),
      with: {
        client: true,
        project: true,
        task: true,
      },
      orderBy: [desc(timeEntries.date), desc(timeEntries.createdAt)],
    });

    // Apply client and project filters
    let filteredEntries = entries;

    if (clientId) {
      filteredEntries = filteredEntries.filter(
        (entry) => entry.clientId === clientId
      );
    }

    if (projectId) {
      filteredEntries = filteredEntries.filter(
        (entry) => entry.projectId === projectId
      );
    }

    // Shape response
    const shapedEntries = filteredEntries.map((entry) =>
      shapeEntryResponse({
        id: entry.id,
        description: entry.description,
        date: entry.date,
        durationMinutes: entry.durationMinutes,
        isBillableOverride: entry.isBillableOverride,
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

    return NextResponse.json(shapedEntries);
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
    console.error("Error fetching entries:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/organizations/[orgId]/entries
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, session } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();

    // Detect batch vs single entry
    const isBatch = Array.isArray(body.entries);
    const entriesToCreate = isBatch ? body.entries : [body];

    if (entriesToCreate.length === 0) {
      return NextResponse.json(
        { error: "At least one entry is required" },
        { status: 400 }
      );
    }

    // Validate and prepare entries
    const preparedEntries: Array<{
      organizationId: string;
      userId: string;
      clientId: string;
      projectId: string | null;
      taskId: string | null;
      description: string | null;
      date: string;
      durationMinutes: number;
      isBillableOverride: boolean | null;
    }> = [];

    for (let i = 0; i < entriesToCreate.length; i++) {
      const entry = entriesToCreate[i];
      const errorPrefix = isBatch ? `Entry ${i}: ` : "";

      // Validate required fields - clientId is required
      if (!entry.clientId) {
        return NextResponse.json(
          { error: `${errorPrefix}clientId is required` },
          { status: 400 }
        );
      }

      if (!entry.date) {
        return NextResponse.json(
          { error: `${errorPrefix}date is required` },
          { status: 400 }
        );
      }

      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(entry.date)) {
        return NextResponse.json(
          { error: `${errorPrefix}date must be in YYYY-MM-DD format` },
          { status: 400 }
        );
      }

      if (
        entry.durationMinutes === undefined ||
        entry.durationMinutes === null
      ) {
        return NextResponse.json(
          { error: `${errorPrefix}durationMinutes is required` },
          { status: 400 }
        );
      }

      const duration = parseInt(String(entry.durationMinutes), 10);
      if (isNaN(duration) || duration <= 0) {
        return NextResponse.json(
          { error: `${errorPrefix}durationMinutes must be a positive integer` },
          { status: 400 }
        );
      }

      // Validate hierarchy
      const validation = await validateEntryHierarchy(
        orgId,
        entry.clientId,
        entry.projectId || null,
        entry.taskId || null
      );

      if (!validation.valid) {
        return NextResponse.json(
          { error: `${errorPrefix}${validation.error}` },
          { status: 400 }
        );
      }

      preparedEntries.push({
        organizationId: orgId,
        userId: session.user.id,
        clientId: entry.clientId,
        projectId: entry.projectId || null,
        taskId: entry.taskId || null,
        description: entry.description?.trim() || null,
        date: entry.date,
        durationMinutes: duration,
        isBillableOverride: entry.isBillableOverride ?? null,
      });
    }

    // Insert entries
    const createdEntries = await db
      .insert(timeEntries)
      .values(preparedEntries)
      .returning();

    // Fetch full entry data with relations for response
    const entryIds = new Set(createdEntries.map((e) => e.id));
    const fullEntries = await db.query.timeEntries.findMany({
      where: eq(timeEntries.organizationId, orgId),
      with: {
        client: true,
        project: true,
        task: true,
      },
    });

    // Filter to only the created entries and shape response
    const shapedEntries = fullEntries
      .filter((entry) => entryIds.has(entry.id))
      .map((entry) =>
        shapeEntryResponse({
          id: entry.id,
          description: entry.description,
          date: entry.date,
          durationMinutes: entry.durationMinutes,
          isBillableOverride: entry.isBillableOverride,
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

    // Return single entry or array depending on input format
    if (isBatch) {
      return NextResponse.json(shapedEntries, { status: 201 });
    } else {
      return NextResponse.json(shapedEntries[0], { status: 201 });
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
    console.error("Error creating entry:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
