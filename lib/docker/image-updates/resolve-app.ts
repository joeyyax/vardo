import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import type { UpdatableApp } from "./compose-images";

export interface ResolvedApp extends UpdatableApp {
  id: string;
  name: string;
  displayName: string;
  /** App that owns `composeContent` — the parent for a child service. */
  composeOwnerId: string;
  isSystemManaged: boolean | null;
}

/**
 * Loads an app with the compose content that actually governs it. Child
 * services carry none of their own, so the parent's is used and narrowed to
 * the child's `composeService`.
 */
export async function resolveUpdatableApp(
  orgId: string,
  appId: string,
): Promise<ResolvedApp | null> {
  const app = await db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
    columns: {
      id: true,
      name: true,
      displayName: true,
      deployType: true,
      imageName: true,
      composeContent: true,
      composeService: true,
      parentAppId: true,
      isSystemManaged: true,
    },
  });
  if (!app) return null;

  let composeContent = app.composeContent;
  let composeOwnerId = app.id;

  if (!composeContent && app.parentAppId) {
    const parent = await db.query.apps.findFirst({
      where: and(eq(apps.id, app.parentAppId), eq(apps.organizationId, orgId)),
      columns: { id: true, composeContent: true },
    });
    if (parent?.composeContent) {
      composeContent = parent.composeContent;
      composeOwnerId = parent.id;
    }
  }

  return {
    id: app.id,
    name: app.name,
    displayName: app.displayName,
    deployType: app.deployType,
    imageName: app.imageName,
    composeContent,
    composeService: app.composeService,
    composeOwnerId,
    isSystemManaged: app.isSystemManaged,
  };
}
