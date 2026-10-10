// Boot-time reconcile of every app's headers file against the database.

import { isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { normalizeHeaderConfig } from "@/lib/security/response-headers";
import { logger } from "@/lib/logger";
import { reconcileHeadersFiles, writeAppHeadersFile } from "./headers-file";

const log = logger.child("headers-sync");

/** Writes a headers file for each top-level app and removes files whose app is gone. */
export async function syncAllHeadersFiles(): Promise<void> {
  const rows = await db
    .select({ id: apps.id, config: apps.securityHeaders })
    .from(apps)
    .where(isNull(apps.parentAppId));
  const list = rows.map((r) => ({ id: r.id, config: normalizeHeaderConfig(r.config) }));
  const { written, removed } = await reconcileHeadersFiles(list);
  if (written || removed) log.info(`Security headers files: ${written} written, ${removed} removed`);
}

/** Rewrites one app's headers file after a settings change. "live" when Traefik picks it up without a redeploy. */
export async function applyAppHeaders(app: {
  id: string;
  name: string;
  securityHeaders: unknown;
  securityHeadersLive: boolean;
}): Promise<{ applied: "live" | "redeploy" }> {
  try {
    const outcome = await writeAppHeadersFile(app.id, normalizeHeaderConfig(app.securityHeaders));
    return { applied: outcome !== "skipped" && app.securityHeadersLive ? "live" : "redeploy" };
  } catch (err) {
    log.error(`Failed to write the security headers file for ${app.name}:`, err);
    return { applied: "redeploy" };
  }
}
