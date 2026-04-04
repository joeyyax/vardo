import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { loadTemplates } from "@/lib/templates/load";
import {
  storeBusinessMetric,
  storeOrgBusinessMetric,
} from "./store-business";

/**
 * Collect business metrics (entity counts) from the database and store them
 * in Redis TimeSeries. Includes both global counts and per-org breakdowns.
 */
export async function collectBusinessMetrics() {
  const ts = Date.now();

  // Global entity counts
  const counts = await db.execute(sql`
    SELECT 'users' AS name, COUNT(*)::text AS count FROM "user"
    UNION ALL SELECT 'organizations', COUNT(*)::text FROM "organization"
    UNION ALL SELECT 'projects', COUNT(*)::text FROM "project"
    UNION ALL SELECT 'apps', COUNT(*)::text FROM "app"
    UNION ALL SELECT 'deployments', COUNT(*)::text FROM "deployment"
    UNION ALL SELECT 'domains', COUNT(*)::text FROM "domain"
    UNION ALL SELECT 'backups', COUNT(*)::text FROM "backup"
    UNION ALL SELECT 'cronJobs', COUNT(*)::text FROM "cron_job"
  `);
  await Promise.allSettled(
    (counts as unknown as { name: string; count: string }[]).map((row) =>
      storeBusinessMetric(
        row.name as Parameters<typeof storeBusinessMetric>[0],
        ts,
        parseInt(row.count),
      )
    )
  );

  // Templates (file-based, not in DB)
  const templateList = await loadTemplates().catch(() => []);
  await storeBusinessMetric("templates", ts, templateList.length);

  // Per-org business metrics — LEFT JOIN aggregations instead of correlated subqueries
  const orgCounts = await db.execute(sql`
    SELECT
      o.id AS org_id,
      COALESCE(ac.cnt, 0)::text AS apps,
      COALESCE(dc.cnt, 0)::text AS deployments,
      COALESCE(dmc.cnt, 0)::text AS domains,
      COALESCE(mc.cnt, 0)::text AS members
    FROM "organization" o
    LEFT JOIN (SELECT organization_id, COUNT(*) AS cnt FROM "app" GROUP BY 1) ac ON ac.organization_id = o.id
    LEFT JOIN (SELECT a.organization_id, COUNT(*) AS cnt FROM "deployment" d JOIN "app" a ON d.app_id = a.id GROUP BY 1) dc ON dc.organization_id = o.id
    LEFT JOIN (SELECT a.organization_id, COUNT(*) AS cnt FROM "domain" dm JOIN "app" a ON dm.app_id = a.id GROUP BY 1) dmc ON dmc.organization_id = o.id
    LEFT JOIN (SELECT organization_id, COUNT(*) AS cnt FROM "membership" GROUP BY 1) mc ON mc.organization_id = o.id
  `);
  await Promise.allSettled(
    (orgCounts as unknown as { org_id: string; apps: string; deployments: string; domains: string; members: string }[]).flatMap((row) => [
      storeOrgBusinessMetric(row.org_id, "apps", ts, parseInt(row.apps)),
      storeOrgBusinessMetric(row.org_id, "deployments", ts, parseInt(row.deployments)),
      storeOrgBusinessMetric(row.org_id, "domains", ts, parseInt(row.domains)),
      storeOrgBusinessMetric(row.org_id, "users", ts, parseInt(row.members)),
    ])
  );
}
