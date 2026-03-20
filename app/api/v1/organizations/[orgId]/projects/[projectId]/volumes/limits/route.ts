import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { volumeLimits, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

const volumeLimitSchema = z.object({
  maxSizeBytes: z.number().int().positive("Max size must be a positive number"),
  warnAtPercent: z.number().int().min(1).max(100).default(80),
});

async function verifyProjectAccess(orgId: string, projectId: string) {
  const { organization } = await requireOrg();

  if (organization.id !== orgId) {
    return null;
  }

  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, projectId),
      eq(projects.organizationId, orgId)
    ),
    columns: { id: true },
  });

  return project;
}

// GET — return the volume limit for a project (or null if not set)
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const limit = await db.query.volumeLimits.findFirst({
      where: eq(volumeLimits.projectId, projectId),
    });

    return NextResponse.json({ limit: limit ?? null });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching volume limit:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PUT — set/update the volume limit
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = volumeLimitSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    // Upsert: try to update first, insert if not exists
    const existing = await db.query.volumeLimits.findFirst({
      where: eq(volumeLimits.projectId, projectId),
    });

    let limit;
    if (existing) {
      [limit] = await db
        .update(volumeLimits)
        .set({
          maxSizeBytes: parsed.data.maxSizeBytes,
          warnAtPercent: parsed.data.warnAtPercent,
          updatedAt: new Date(),
        })
        .where(eq(volumeLimits.id, existing.id))
        .returning();
    } else {
      [limit] = await db
        .insert(volumeLimits)
        .values({
          id: nanoid(),
          projectId,
          maxSizeBytes: parsed.data.maxSizeBytes,
          warnAtPercent: parsed.data.warnAtPercent,
        })
        .returning();
    }

    return NextResponse.json({ limit });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error setting volume limit:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE — remove the volume limit
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [deleted] = await db
      .delete(volumeLimits)
      .where(eq(volumeLimits.projectId, projectId))
      .returning({ id: volumeLimits.id });

    if (!deleted) {
      return NextResponse.json({ error: "No limit set" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting volume limit:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
