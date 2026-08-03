// ---------------------------------------------------------------------------
// Top-level app name uniqueness
//
// A top-level app's name is its runtime namespace: the on-disk directory, the
// compose project, the metrics key and the Loki selector. It is therefore
// unique instance-wide, not per organization.
// ---------------------------------------------------------------------------

import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { getPgConstraint, isUniqueViolation } from "@/lib/api/error-response";

/** Partial unique index on app(name) WHERE parent_app_id IS NULL. */
export const TOP_LEVEL_NAME_CONSTRAINT = "app_top_level_name_uniq";

/** Legacy per-organization constraint on app(organization_id, name). */
export const ORG_NAME_CONSTRAINT = "app_org_name_uniq";

/**
 * Shown when a name is taken. Deliberately says nothing about which
 * organization holds it.
 */
export const APP_NAME_TAKEN_ERROR =
  "That app name is already taken. App names must be unique across the whole instance.";

/**
 * True when any top-level app already uses this name, in any organization.
 * Pass `excludeAppId` when checking a rename against the app's own row.
 */
export async function isTopLevelAppNameTaken(
  name: string,
  excludeAppId?: string
): Promise<boolean> {
  const existing = await db.query.apps.findFirst({
    where: and(
      eq(apps.name, name),
      isNull(apps.parentAppId),
      ...(excludeAppId ? [ne(apps.id, excludeAppId)] : [])
    ),
    columns: { id: true },
  });
  return !!existing;
}

/** True when the error is a unique violation on either app-name constraint. */
export function isAppNameViolation(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const constraint = getPgConstraint(error);
  // A driver that drops the constraint name leaves us unable to tell which
  // unique index fired, so fall back to treating it as a name clash.
  if (constraint === null) return true;
  return (
    constraint === TOP_LEVEL_NAME_CONSTRAINT || constraint === ORG_NAME_CONSTRAINT
  );
}
