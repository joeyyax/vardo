import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { verifyProjectAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

const createDomainSchema = z.object({
  domain: z.string().min(1, "Domain is required"),
  serviceName: z.string().optional(),
  port: z.number().int().positive().optional(),
  certResolver: z.string().default("le"),
});

const deleteDomainSchema = z.object({
  id: z.string().min(1),
});

// POST /api/v1/organizations/[orgId]/projects/[projectId]/domains
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = createDomainSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [created] = await db
      .insert(domains)
      .values({
        id: nanoid(),
        projectId,
        domain: parsed.data.domain,
        serviceName: parsed.data.serviceName,
        port: parsed.data.port,
        certResolver: parsed.data.certResolver,
      })
      .returning();

    return NextResponse.json({ domain: created }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "23505"
    ) {
      return NextResponse.json(
        { error: "Domain already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error creating domain");
  }
}

const updateDomainSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1).optional(),
  port: z.number().int().positive().nullable().optional(),
});

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]/domains
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = updateDomainSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { id, ...updates } = parsed.data;

    const [updated] = await db
      .update(domains)
      .set(updates)
      .where(and(eq(domains.id, id), eq(domains.projectId, projectId)))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ domain: updated });
  } catch (error) {
    return handleRouteError(error, "Error updating domain");
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/domains
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = deleteDomainSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [deleted] = await db
      .delete(domains)
      .where(
        and(
          eq(domains.id, parsed.data.id),
          eq(domains.projectId, projectId)
        )
      )
      .returning({ id: domains.id });

    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting domain");
  }
}
