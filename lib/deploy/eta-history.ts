// Each app's last run times, which the queue's start estimates walk.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";

/** The app's last successful deploy time, for the deploy-slot line. */
export const typicalDeploySql = (appId: SQL) => sql`(
  SELECT p.duration_ms FROM deployment p
  WHERE p.app_id = ${appId} AND p.status = 'success' AND p.duration_ms IS NOT NULL
  ORDER BY p.started_at DESC LIMIT 1
)`;

/** The app's last successful build and export time, for the builder line. */
const typicalBuildSql = (appId: SQL) => sql`(
  SELECT (coalesce((p.stage_timings->'build'->>'ms')::int, 0) + coalesce((p.stage_timings->'export'->>'ms')::int, 0))
  FROM deployment p
  WHERE p.app_id = ${appId} AND p.status = 'success' AND p.stage_timings ? 'build'
  ORDER BY p.started_at DESC LIMIT 1
)`;

const buildCache = new Map<string, { ms: number | null; at: number }>();
const BUILD_CACHE_MS = 60_000;

/** Typical build time for each deployment's app, cached briefly. Unknown ids map to null. */
export async function typicalBuildMs(deploymentIds: string[]): Promise<Map<string, number | null>> {
  const now = Date.now();
  const out = new Map<string, number | null>();
  const missing: string[] = [];
  if (buildCache.size > 1000) for (const [id, hit] of buildCache) if (now - hit.at >= BUILD_CACHE_MS) buildCache.delete(id);
  for (const id of new Set(deploymentIds)) {
    const hit = buildCache.get(id);
    if (hit && now - hit.at < BUILD_CACHE_MS) out.set(id, hit.ms);
    else missing.push(id);
  }
  if (missing.length > 0) {
    const rows = await db.execute<{ id: string; ms: number | null }>(sql`
      SELECT d.id, ${typicalBuildSql(sql`d.app_id`)} AS ms
      FROM deployment d WHERE d.id IN (${sql.join(missing.map((id) => sql`${id}`), sql`, `)})`);
    const found = new Map([...rows].map((r) => [r.id, r.ms === null ? null : Number(r.ms)]));
    for (const id of missing) {
      const ms = found.get(id) ?? null;
      buildCache.set(id, { ms, at: now });
      out.set(id, ms);
    }
  }
  return out;
}
