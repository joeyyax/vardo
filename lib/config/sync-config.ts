/**
 * Sync vardo.yml config-as-code declarations to the database.
 *
 * When an app has configSource: "vardo.yml", this module upserts domain
 * records from the networking block and removes stale records that are
 * no longer declared in the config.
 */

import { db } from "@/lib/db";
import { apps, domains } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { VardoEnvConfig } from "./vardo-config";
import { parseNetworking } from "./parse-networking";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";

/**
 * Sync domains from a vardo.yml networking block to the database.
 * Upserts matching domains, removes domains no longer in the config.
 * Returns the list of synced domain records for use in deploy.
 */
export async function syncNetworkingConfig(
  appId: string,
  envConfig: VardoEnvConfig,
  containerPort: number = 3000
): Promise<{ created: string[]; removed: string[]; unchanged: string[] }> {
  const result = { created: [] as string[], removed: [] as string[], unchanged: [] as string[] };

  if (!envConfig.networking) return result;

  const parsed = parseNetworking(envConfig.networking, containerPort);
  if (parsed.length === 0) return result;

  const sslConfig = await getSslConfig();
  const certResolver = getPrimaryIssuer(sslConfig);

  // Get existing domains for this app
  const existing = await db.query.domains.findMany({
    where: eq(domains.appId, appId),
  });
  const existingByDomain = new Map(existing.map((d) => [d.domain, d]));

  // Upsert domains from config
  const configDomains = new Set<string>();
  for (const pd of parsed) {
    configDomains.add(pd.domain);
    const ex = existingByDomain.get(pd.domain);

    if (ex) {
      // Update if changed
      const needsUpdate =
        ex.port !== pd.port ||
        ex.isPrimary !== pd.isPrimary ||
        ex.sslEnabled !== pd.ssl ||
        ex.redirectTo !== (pd.redirectTo ?? null) ||
        ex.redirectCode !== (pd.redirectCode ?? null);

      if (needsUpdate) {
        await db
          .update(domains)
          .set({
            port: pd.port,
            isPrimary: pd.isPrimary,
            sslEnabled: pd.ssl,
            certResolver,
            redirectTo: pd.redirectTo ?? null,
            redirectCode: pd.redirectCode ?? null,
          })
          .where(eq(domains.id, ex.id));
      }
      result.unchanged.push(pd.domain);
    } else {
      // Create new domain
      await db.insert(domains).values({
        id: nanoid(),
        appId,
        domain: pd.domain,
        port: pd.port,
        isPrimary: pd.isPrimary,
        sslEnabled: pd.ssl,
        certResolver,
        redirectTo: pd.redirectTo ?? null,
        redirectCode: pd.redirectCode ?? null,
      });
      result.created.push(pd.domain);
    }
  }

  // Remove domains no longer in config
  for (const ex of existing) {
    if (!configDomains.has(ex.domain)) {
      await db.delete(domains).where(eq(domains.id, ex.id));
      result.removed.push(ex.domain);
    }
  }

  return result;
}

/**
 * Mark an app as config-managed by vardo.yml.
 */
export async function setConfigSource(
  appId: string,
  source: "vardo.yml" | null
): Promise<void> {
  await db
    .update(apps)
    .set({ configSource: source, updatedAt: new Date() })
    .where(eq(apps.id, appId));
}
