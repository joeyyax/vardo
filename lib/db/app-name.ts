// Top-level app names are unique instance-wide: they're the directory, compose project, metrics key and Loki selector.

import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { getPgConstraint, isUniqueViolation } from "@/lib/api/error-response";

/** Partial unique index on app(name) WHERE parent_app_id IS NULL. */
export const TOP_LEVEL_NAME_CONSTRAINT = "app_top_level_name_uniq";

/** Legacy per-organization constraint on app(organization_id, name). */
export const ORG_NAME_CONSTRAINT = "app_org_name_uniq";

/** Shown when a name is taken. Never names the organization that holds it. */
export const APP_NAME_TAKEN_ERROR =
  "That app name is already taken. App names must be unique across the whole instance.";

/** Whether any top-level app in any organization uses this name. */
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
  // No constraint name: treat it as a name clash.
  if (constraint === null) return true;
  return (
    constraint === TOP_LEVEL_NAME_CONSTRAINT || constraint === ORG_NAME_CONSTRAINT
  );
}
