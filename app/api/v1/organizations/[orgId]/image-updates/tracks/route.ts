import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { requirePlugin } from "@/lib/api/require-plugin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { imageUpdateTracks } from "@/lib/db/schema";
import { resolveUpdatableApp } from "@/lib/docker/image-updates/resolve-app";
import { recordActivity } from "@/lib/activity";
import { readTrackPolicies } from "@/lib/docker/image-updates/read-tracks";
import { TRACK_MODES } from "@/lib/docker/image-updates/track-policy";

type RouteParams = { params: Promise<{ orgId: string }> };

const targetSchema = {
  appId: z.string().min(1).max(64),
  /** Compose service. Omit for a single-image app. */
  service: z.string().min(1).max(255).nullish(),
};

const setSchema = z.object({ ...targetSchema, mode: z.enum(TRACK_MODES) }).strict();
const deleteSchema = z.object(targetSchema).strict();

/** Policies key on the app that owns the compose, so a child's choice matches the fleet view. */
async function ownerOf(orgId: string, appId: string): Promise<string | null> {
  return (await resolveUpdatableApp(orgId, appId))?.composeOwnerId ?? null;
}

// GET — explicit policies in the org. Services without one use their image's default.
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  try {
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();

    const gate = await requirePlugin("image-updates");
    if (gate) return gate;
    return NextResponse.json({ tracks: await readTrackPolicies(orgId) });
  } catch (error) {
    return handleRouteError(error, "Error reading track policies");
  }
}

// POST — follow latest or stay on the running major, for one app or compose service.
async function handlePost(request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  try {
    const org = await verifyOrgAccess(orgId, "app.config");
    if (!org) return apiError.forbidden();

    const gate = await requirePlugin("image-updates");
    if (gate) return gate;

    const parsed = setSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return apiError.validation(parsed.error);

    const appId = await ownerOf(orgId, parsed.data.appId);
    if (!appId) return apiError.notFound("app");
    const service = parsed.data.service ?? null;
    const { mode } = parsed.data;

    await db
      .insert(imageUpdateTracks)
      .values({
        id: nanoid(),
        organizationId: orgId,
        appId,
        composeService: service,
        mode,
        updatedBy: org.session.user.id,
      })
      .onConflictDoUpdate({
        target: [imageUpdateTracks.appId, imageUpdateTracks.composeService],
        set: { mode, updatedBy: org.session.user.id, updatedAt: new Date() },
      });

    await recordActivity({
      organizationId: orgId,
      action: "app.image_track_changed",
      appId,
      userId: org.session.user.id,
      metadata: { service, mode },
    }).catch(() => {});

    return NextResponse.json({ track: { appId, composeService: service, mode } });
  } catch (error) {
    return handleRouteError(error, "Error saving track policy");
  }
}

// DELETE — back to the image's default.
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  try {
    const org = await verifyOrgAccess(orgId, "app.config");
    if (!org) return apiError.forbidden();

    const gate = await requirePlugin("image-updates");
    if (gate) return gate;

    const parsed = deleteSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return apiError.validation(parsed.error);

    const appId = await ownerOf(orgId, parsed.data.appId);
    if (!appId) return apiError.notFound("app");
    const service = parsed.data.service ?? null;

    const removed = await db
      .delete(imageUpdateTracks)
      .where(
        and(
          eq(imageUpdateTracks.organizationId, orgId),
          eq(imageUpdateTracks.appId, appId),
          service === null
            ? isNull(imageUpdateTracks.composeService)
            : eq(imageUpdateTracks.composeService, service),
        ),
      )
      .returning({ id: imageUpdateTracks.id });

    return NextResponse.json({ removed: removed.length });
  } catch (error) {
    return handleRouteError(error, "Error removing track policy");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/image-updates/tracks" });
export const POST = withRateLimit(handlePost, { tier: "mutation", key: "image-update-tracks" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "image-update-tracks" });
