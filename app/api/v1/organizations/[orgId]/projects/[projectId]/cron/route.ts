import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { cronJobs } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { verifyProjectAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

const createCronSchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: z.enum(["command", "url"]).default("command"),
  schedule: z.string().min(1, "Schedule is required"),
  command: z.string().min(1, "Command is required"),
  enabled: z.boolean().optional().default(true),
});

const updateCronSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  type: z.enum(["command", "url"]).optional(),
  schedule: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

const deleteCronSchema = z.object({
  id: z.string().min(1),
});

// GET /api/v1/organizations/[orgId]/projects/[projectId]/cron
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const jobs = await db.query.cronJobs.findMany({
      where: eq(cronJobs.projectId, projectId),
      orderBy: (cronJobs, { asc }) => [asc(cronJobs.name)],
    });

    return NextResponse.json({ cronJobs: jobs });
  } catch (error) {
    return handleRouteError(error, "Error listing cron jobs");
  }
}

// POST /api/v1/organizations/[orgId]/projects/[projectId]/cron
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = createCronSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [created] = await db
      .insert(cronJobs)
      .values({
        id: nanoid(),
        projectId,
        name: parsed.data.name,
        type: parsed.data.type,
        schedule: parsed.data.schedule,
        command: parsed.data.command,
        enabled: parsed.data.enabled,
      })
      .returning();

    return NextResponse.json({ cronJob: created }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error creating cron job");
  }
}

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]/cron
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = updateCronSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { id, ...updates } = parsed.data;

    const [updated] = await db
      .update(cronJobs)
      .set({ ...updates, updatedAt: new Date() })
      .where(and(eq(cronJobs.id, id), eq(cronJobs.projectId, projectId)))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ cronJob: updated });
  } catch (error) {
    return handleRouteError(error, "Error updating cron job");
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/cron
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = deleteCronSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [deleted] = await db
      .delete(cronJobs)
      .where(
        and(
          eq(cronJobs.id, parsed.data.id),
          eq(cronJobs.projectId, projectId)
        )
      )
      .returning({ id: cronJobs.id });

    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting cron job");
  }
}
