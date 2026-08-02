import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { applyImageUpdate } from "@/lib/docker/image-updates/apply-update";
import { getAppUpdateStatus } from "@/lib/docker/image-updates/status";
import { readIgnoreRules } from "@/lib/docker/image-updates/read-ignores";
import { resolveUpdatableApp } from "@/lib/docker/image-updates/resolve-app";

type RouteParams = { params: Promise<{ orgId: string; appId: string }> };

const applySchema = z
  .object({
    /** Compose service to move. Omit for single-image apps. */
    service: z.string().min(1).max(255).nullish(),
    /** Must match the tag the last check proposed. */
    tag: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w][\w.-]*$/, "Invalid tag"),
    /** Required to cross a major on an image whose data dir is version-locked. */
    acknowledgeMigration: z.boolean().optional(),
  })
  .strict();

// GET — cached update state. Never contacts a registry.
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  const { orgId, appId } = await params;
  try {
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const app = await resolveUpdatableApp(orgId, appId);
    if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json(await getAppUpdateStatus(app, await readIgnoreRules(orgId)));
  } catch (error) {
    return handleRouteError(error, "Error reading image update status");
  }
}

// POST — rewrites the pinned tag and marks the app for redeploy.
async function handlePost(request: NextRequest, { params }: RouteParams) {
  const { orgId, appId } = await params;
  try {
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const parsed = applySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const outcome = await applyImageUpdate({
      orgId,
      appId,
      userId: org.session.user.id,
      service: parsed.data.service,
      tag: parsed.data.tag,
      acknowledgeMigration: parsed.data.acknowledgeMigration,
    });

    if (!outcome.ok) {
      return NextResponse.json(
        {
          error: outcome.error,
          ...(outcome.requiresMigration
            ? {
                requiresMigration: true,
                from: outcome.from,
                to: outcome.to,
                plan: outcome.plan,
              }
            : {}),
        },
        { status: outcome.status },
      );
    }

    return NextResponse.json({
      previousImage: outcome.previousImage,
      newImage: outcome.newImage,
      service: outcome.service,
      needsDeploy: true,
    });
  } catch (error) {
    return handleRouteError(error, "Error applying image update");
  }
}

export const GET = handleGet;
export const POST = withRateLimit(handlePost, { tier: "mutation", key: "app-image-updates" });
