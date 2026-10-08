import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError, isUniqueViolation } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { environments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { HOSTNAME_RE } from "@/lib/security/hostname";
import { verifyAppAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; envId: string }>;
};

const updateEnvironmentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .optional(),
  domain: z.union([z.literal(""), z.string().regex(HOSTNAME_RE, "Invalid domain name")]).nullable().optional(),
}).strict();

// PATCH /api/v1/organizations/[orgId]/apps/[appId]/environments/[envId]
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId, envId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.config");

    if (!app) {
      return apiError.notFound("app");
    }

    const body = await request.json();
    const parsed = updateEnvironmentSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
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
          eq(environments.appId, appId)
        )
      )
      .returning();

    if (!updated) {
      return apiError.notFound("environment");
    }

    return NextResponse.json({ environment: updated });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json(
        { error: "An environment with this name already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error updating environment");
  }
}

// DELETE /api/v1/organizations/[orgId]/apps/[appId]/environments/[envId]
async function handleDelete(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId, envId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.config");

    if (!app) {
      return apiError.notFound("app");
    }

    const env = await db.query.environments.findFirst({
      where: and(
        eq(environments.id, envId),
        eq(environments.appId, appId)
      ),
    });

    if (!env) {
      return apiError.notFound("environment");
    }

    if (env.type === "production") {
      return NextResponse.json(
        { error: "Can't delete a production environment" },
        { status: 400 }
      );
    }

    if (env.isDefault) {
      return NextResponse.json(
        { error: "Can't delete the default environment" },
        { status: 400 }
      );
    }

    // Cascading delete removes env vars.
    const [deleted] = await db
      .delete(environments)
      .where(
        and(
          eq(environments.id, envId),
          eq(environments.appId, appId)
        )
      )
      .returning({ id: environments.id });

    if (!deleted) {
      return apiError.notFound("environment");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting environment");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "apps-environments" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "apps-environments" });
