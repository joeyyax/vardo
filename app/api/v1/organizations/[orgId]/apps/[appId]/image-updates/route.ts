import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity";
import { majorOf, planMigration } from "@/lib/docker/image-updates/migration-path";
import { isMajorLocked } from "@/lib/docker/image-updates/stateful-image";
import { setImageRefTag, setServiceImageTag } from "@/lib/docker/image-updates/apply";
import { getAppUpdateStatus } from "@/lib/docker/image-updates/status";
import { resolveUpdatableApp } from "@/lib/docker/image-updates/resolve-app";

type RouteParams = { params: Promise<{ orgId: string; appId: string }> };

/** True when `to` lands on a higher major than `from`. */
function isMajorJump(from: string, to: string): boolean {
  const a = majorOf(from);
  const b = majorOf(to);
  return a !== null && b !== null && b > a;
}

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

    return NextResponse.json(await getAppUpdateStatus(app));
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

    const app = await resolveUpdatableApp(orgId, appId);
    if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (app.isSystemManaged) {
      return NextResponse.json({ error: "System-managed apps update themselves" }, { status: 403 });
    }

    const parsed = applySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const { tag } = parsed.data;
    const service = parsed.data.service ?? app.composeService ?? null;

    const status = await getAppUpdateStatus(app);
    const target = status.services.find((entry) => entry.service === service);
    if (!target) {
      return NextResponse.json({ error: "No such service on this app" }, { status: 404 });
    }
    // Only apply what a check actually proposed — this is not a free-form tag editor.
    const offered = new Set(
      [target.latestTag, target.majorAvailable, ...target.available].filter(
        (t): t is string => t !== null,
      ),
    );
    if (!offered.has(tag)) {
      return NextResponse.json(
        { error: `No verified update to ${tag}. Re-run the check first.` },
        { status: 409 },
      );
    }

    // A major bump on a major-locked image cannot start against the existing
    // data directory. Require the caller to say so explicitly.
    //
    // Recomputed from the image rather than read off the cached row: a row
    // written before this guard existed carries majorLocked = false, and
    // trusting it would wave through the exact update this prevents.
    const crossesMajor = isMajorLocked(target.image) && isMajorJump(target.currentTag, tag);
    if (crossesMajor && !parsed.data.acknowledgeMigration) {
      const plan = planMigration(target.image, target.currentTag, tag);
      return NextResponse.json(
        {
          error: `${target.image} stores data in a format tied to its major version. Moving from ${target.currentTag} to ${tag} needs a data migration — back up first, then confirm.`,
          requiresMigration: true,
          from: target.currentTag,
          to: tag,
          plan,
        },
        { status: 409 },
      );
    }

    if (app.deployType === "image") {
      const change = setImageRefTag(app.imageName ?? "", tag);
      if (!change) return NextResponse.json({ error: "Image tag unchanged" }, { status: 409 });
      await db
        .update(apps)
        .set({ imageName: change.newImage, needsRedeploy: true, updatedAt: new Date() })
        .where(eq(apps.id, app.id));
      await logUpdate(orgId, app.id, org.session.user.id, change, null);
      return NextResponse.json({ ...change, service: null, needsDeploy: true });
    }

    if (!service || !app.composeContent) {
      return NextResponse.json({ error: "App has no compose service to update" }, { status: 400 });
    }

    const change = setServiceImageTag(app.composeContent, service, tag);
    if (!change) {
      return NextResponse.json({ error: "Could not rewrite that image tag" }, { status: 409 });
    }

    // Written to whichever app owns the compose; siblings are untouched.
    await db
      .update(apps)
      .set({ composeContent: change.content, updatedAt: new Date() })
      .where(eq(apps.id, app.composeOwnerId));
    await db
      .update(apps)
      .set({ needsRedeploy: true, updatedAt: new Date() })
      .where(eq(apps.id, app.id));

    await logUpdate(orgId, app.id, org.session.user.id, change, service);
    return NextResponse.json({
      previousImage: change.previousImage,
      newImage: change.newImage,
      service,
      needsDeploy: true,
    });
  } catch (error) {
    return handleRouteError(error, "Error applying image update");
  }
}

function logUpdate(
  organizationId: string,
  appId: string,
  userId: string,
  change: { previousImage: string; newImage: string },
  service: string | null,
) {
  return recordActivity({
    organizationId,
    action: "app.image_updated",
    appId,
    userId,
    metadata: { service, from: change.previousImage, to: change.newImage },
  }).catch(() => {});
}

export const GET = handleGet;
export const POST = withRateLimit(handlePost, { tier: "mutation", key: "app-image-updates" });
