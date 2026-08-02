import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity";
import { planMigration, requiresMigration, type MigrationPlan } from "./migration-path";
import { setImageRefTag, setServiceImageTag } from "./apply";
import { getAppUpdateStatus } from "./status";
import { resolveUpdatableApp } from "./resolve-app";

export interface ApplyRequest {
  orgId: string;
  appId: string;
  userId: string;
  /** Compose service to move. Omit for single-image apps. */
  service?: string | null;
  tag: string;
  acknowledgeMigration?: boolean;
}

export type ApplyOutcome =
  | {
      ok: true;
      appId: string;
      appName: string;
      displayName: string;
      service: string | null;
      previousImage: string;
      newImage: string;
    }
  | {
      ok: false;
      appId: string;
      appName: string | null;
      displayName: string | null;
      service: string | null;
      status: number;
      error: string;
      requiresMigration?: true;
      from?: string;
      to?: string;
      plan?: MigrationPlan | null;
    };

/**
 * Rewrites one pinned tag and marks the app for redeploy.
 *
 * Callers must run these one at a time: siblings of a compose parent write the
 * same `composeContent`, and a parallel pair would drop one of the two edits.
 */
export async function applyImageUpdate({
  orgId,
  appId,
  userId,
  service: requestedService,
  tag,
  acknowledgeMigration,
}: ApplyRequest): Promise<ApplyOutcome> {
  const app = await resolveUpdatableApp(orgId, appId);
  if (!app) {
    return fail({ appId, appName: null, displayName: null, service: requestedService ?? null }, 404, "Not found");
  }

  const identity = {
    appId: app.id,
    appName: app.name,
    displayName: app.displayName,
    service: requestedService ?? app.composeService ?? null,
  };

  if (app.isSystemManaged) {
    return fail(identity, 403, "System-managed apps update themselves");
  }

  const service = identity.service;
  const status = await getAppUpdateStatus(app);
  const target = status.services.find((entry) => entry.service === service);
  if (!target) {
    return fail(identity, 404, "No such service on this app");
  }

  // Only apply what a check actually proposed — this is not a free-form tag editor.
  const offered = new Set(
    [target.latestTag, target.majorAvailable, ...target.available].filter(
      (t): t is string => t !== null,
    ),
  );
  if (!offered.has(tag)) {
    return fail(identity, 409, `No verified update to ${tag}. Re-run the check first.`);
  }

  // A major bump on a major-locked image cannot start against the existing
  // data directory. Require the caller to say so explicitly.
  if (requiresMigration(target.image, target.currentTag, tag) && !acknowledgeMigration) {
    return {
      ...identity,
      ok: false,
      status: 409,
      error: `${target.image} stores data in a format tied to its major version. Moving from ${target.currentTag} to ${tag} needs a data migration — back up first, then confirm.`,
      requiresMigration: true,
      from: target.currentTag,
      to: tag,
      plan: planMigration(target.image, target.currentTag, tag),
    };
  }

  if (app.deployType === "image") {
    const change = setImageRefTag(app.imageName ?? "", tag);
    if (!change) return fail(identity, 409, "Image tag unchanged");
    await db
      .update(apps)
      .set({ imageName: change.newImage, needsRedeploy: true, updatedAt: new Date() })
      .where(eq(apps.id, app.id));
    await logUpdate(orgId, app.id, userId, change, null);
    return { ...identity, ok: true, service: null, ...change };
  }

  if (!service || !app.composeContent) {
    return fail(identity, 400, "App has no compose service to update");
  }

  const change = setServiceImageTag(app.composeContent, service, tag);
  if (!change) {
    return fail(identity, 409, "Could not rewrite that image tag");
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

  await logUpdate(orgId, app.id, userId, change, service);
  return {
    ...identity,
    ok: true,
    previousImage: change.previousImage,
    newImage: change.newImage,
  };
}

type Identity = {
  appId: string;
  appName: string | null;
  displayName: string | null;
  service: string | null;
};

function fail(identity: Identity, status: number, error: string): ApplyOutcome {
  return { ...identity, ok: false, status, error };
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
