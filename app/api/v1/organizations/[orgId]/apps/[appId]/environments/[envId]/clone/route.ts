import { NextRequest, NextResponse } from "next/server";
import { handleRouteError, isUniqueViolation } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { environments, envVars } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { verifyAppAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; envId: string }>;
};

const cloneSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(100)
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
      "Name must be lowercase alphanumeric with hyphens"
    ),
  type: z.enum(["production", "staging", "preview", "local"]).optional(),
  domain: z.string().optional(),
}).strict();

// POST /api/v1/organizations/[orgId]/apps/[appId]/environments/[envId]/clone
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId, envId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = cloneSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    // Get the source environment
    const sourceEnv = await db.query.environments.findFirst({
      where: and(
        eq(environments.id, envId),
        eq(environments.appId, appId)
      ),
    });

    if (!sourceEnv) {
      return NextResponse.json(
        { error: "Source environment not found" },
        { status: 404 }
      );
    }

    // Get the source environment's env vars
    const sourceVars = await db.query.envVars.findMany({
      where: and(
        eq(envVars.appId, appId),
        eq(envVars.environmentId, envId)
      ),
    });

    const newEnvId = nanoid();

    await db.transaction(async (tx) => {
      // Create the new environment
      await tx.insert(environments).values({
        id: newEnvId,
        appId,
        name: parsed.data.name,
        type: parsed.data.type ?? sourceEnv.type,
        domain: parsed.data.domain || null,
        isDefault: false,
        clonedFromId: envId,
      });

      // Clone env vars
      if (sourceVars.length > 0) {
        await tx.insert(envVars).values(
          sourceVars.map((v) => ({
            id: nanoid(),
            appId,
            key: v.key,
            value: v.value,
            environmentId: newEnvId,
            isSecret: v.isSecret,
          }))
        );
      }
    });

    const created = await db.query.environments.findFirst({
      where: eq(environments.id, newEnvId),
    });

    return NextResponse.json(
      {
        environment: created,
        clonedVars: sourceVars.length,
      },
      { status: 201 }
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json(
        { error: "An environment with this name already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error cloning environment");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "environments-clone" });
