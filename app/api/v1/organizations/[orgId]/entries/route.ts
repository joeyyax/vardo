import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timeEntries } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import {
  resolveEntryBillable,
  getTaskWithChainForOrg,
} from "@/lib/entries/resolve-billable";

type RouteParams = {
  params: Promise<{ orgId: string }>;
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

    // Build query - we need to join through tasks -> projects -> clients to filter
    // Start with the base time entries query
    const entries = await db.query.timeEntries.findMany({
      where: and(
        eq(timeEntries.organizationId, orgId),
        eq(timeEntries.userId, userId),
        gte(timeEntries.date, from),
        lte(timeEntries.date, to)
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
      orderBy: [desc(timeEntries.date), desc(timeEntries.createdAt)],
    });

    // Apply client and project filters in memory since drizzle relations don't support
    // filtering through nested relations directly
    let filteredEntries = entries;

    if (projectId) {
      filteredEntries = filteredEntries.filter(
        (entry) => entry.task.projectId === projectId
      );
    }

    if (clientId) {
      filteredEntries = filteredEntries.filter(
        (entry) => entry.task.project.clientId === clientId
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
      taskId: string;
      description: string | null;
      date: string;
      durationMinutes: number;
      isBillableOverride: boolean | null;
    }> = [];

    const taskCache = new Map<
      string,
      Awaited<ReturnType<typeof getTaskWithChainForOrg>>
    >();

    for (let i = 0; i < entriesToCreate.length; i++) {
      const entry = entriesToCreate[i];
      const errorPrefix = isBatch ? `Entry ${i}: ` : "";

      // Validate required fields
      if (!entry.taskId) {
        return NextResponse.json(
          { error: `${errorPrefix}taskId is required` },
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

      // Validate task belongs to org (with caching for batch operations)
      let task = taskCache.get(entry.taskId);
      if (task === undefined) {
        task = await getTaskWithChainForOrg(entry.taskId, orgId);
        taskCache.set(entry.taskId, task);
      }

      if (!task) {
        return NextResponse.json(
          { error: `${errorPrefix}Task not found or does not belong to organization` },
          { status: 404 }
        );
      }

      preparedEntries.push({
        organizationId: orgId,
        userId: session.user.id,
        taskId: entry.taskId,
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
    const entryIds = createdEntries.map((e) => e.id);
    const fullEntries = await db.query.timeEntries.findMany({
      where: and(
        eq(timeEntries.organizationId, orgId),
        // Filter to just the created entries
        // Since drizzle doesn't have inArray in this context, we'll fetch one by one
        // This is fine for small batch sizes; for large batches we'd optimize differently
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

    // Filter to only the created entries and shape response
    const createdEntrySet = new Set(entryIds);
    const shapedEntries = fullEntries
      .filter((entry) => createdEntrySet.has(entry.id))
      .map((entry) =>
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
