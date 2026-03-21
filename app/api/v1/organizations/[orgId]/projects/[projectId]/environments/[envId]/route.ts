import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { environments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { verifyProjectAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; envId: string }>;
};

const updateEnvironmentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .optional(),
  domain: z.string().nullable().optional(),
});

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]/environments/[envId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, envId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = updateEnvironmentSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.domain !== undefined) updates.domain = parsed.data.domain;

    const [updated] = await db
      .update(environments)
      .set(updates)
      .where(
        and(
          eq(environments.id, envId),
          eq(environments.projectId, projectId)
        )
      )
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ environment: updated });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "23505"
    ) {
      return NextResponse.json(
        { error: "An environment with this name already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error updating environment");
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/environments/[envId]
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, envId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Check if this is the default/production environment
    const env = await db.query.environments.findFirst({
      where: and(
        eq(environments.id, envId),
        eq(environments.projectId, projectId)
      ),
    });

    if (!env) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (env.type === "production") {
      return NextResponse.json(
        { error: "Cannot delete a production environment" },
        { status: 400 }
      );
    }

    if (env.isDefault) {
      return NextResponse.json(
        { error: "Cannot delete the default environment" },
        { status: 400 }
      );
    }

    // Cascading delete handles env vars via FK constraint
    const [deleted] = await db
      .delete(environments)
      .where(
        and(
          eq(environments.id, envId),
          eq(environments.projectId, projectId)
        )
      )
      .returning({ id: environments.id });

    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting environment");
  }
}
