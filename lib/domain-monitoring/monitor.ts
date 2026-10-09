import { db } from "@/lib/db";
import { domainChecks } from "@/lib/db/schema";
import { desc, sql, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import pLimit from "p-limit";
import { logger } from "@/lib/logger";
import { safeFetch } from "@/lib/security/safe-fetch";
import { getDomainProbePolicy } from "@/lib/security/outbound-policy";
import type { OutboundPolicy } from "@/lib/security/ssrf";

const log = logger.child("domain-monitor");

const MAX_CONCURRENCY = 5;

type DomainCheckResult = {
  domainId: string;
  domain: string;
  appName: string;
  reachable: boolean;
  statusCode?: number;
  responseTimeMs: number;
  error?: string;
};

/** Probe every active app's domains, MAX_CONCURRENCY at a time. */
export async function checkAllDomains(): Promise<DomainCheckResult[]> {
  const allDomains = await db.query.domains.findMany({
    with: {
      app: {
        columns: { id: true, name: true, status: true },
      },
    },
  });

  const eligible = allDomains.filter(
    (d) => d.app.status === "active" && !d.domain.includes("localhost"),
  );

  if (eligible.length === 0) return [];

  // Latest check per domain, for state-transition detection.
  const domainIds = eligible.map((d) => d.id);
  const prevChecks = await db
    .select({
      domainId: domainChecks.domainId,
      reachable: domainChecks.reachable,
    })
    .from(domainChecks)
    .where(inArray(domainChecks.domainId, domainIds))
    .orderBy(domainChecks.domainId, desc(domainChecks.checkedAt))
    .then((rows) => {
      const map = new Map<string, { reachable: boolean }>();
      for (const row of rows) {
        if (!map.has(row.domainId)) {
          map.set(row.domainId, { reachable: row.reachable });
        }
      }
      return map;
    });

  const limit = pLimit(MAX_CONCURRENCY);
  const policy = await getDomainProbePolicy();

  const results = await Promise.allSettled(
    eligible.map((d) =>
      limit(() => probeDomain(d, prevChecks.get(d.id), policy)),
    ),
  );

  const checks: DomainCheckResult[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") checks.push(r.value);
  }

  // Keep the 100 most recent checks per domain.
  try {
    await db.execute(sql`
      DELETE FROM "domain_check"
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY domain_id ORDER BY checked_at DESC) AS rn
          FROM "domain_check"
          WHERE domain_id IN (${sql.join(domainIds.map((id) => sql`${id}`), sql`, `)})
        ) ranked
        WHERE rn > 100
      )
    `);
  } catch {
    // Best-effort.
  }

  return checks;
}

async function probeDomain(
  d: { id: string; domain: string; pathPrefix?: string | null; app: { name: string } },
  prevCheck: { reachable: boolean } | undefined,
  policy: OutboundPolicy,
): Promise<DomainCheckResult> {
  const startTime = Date.now();
  let reachable = false;
  let statusCode: number | undefined;
  let error: string | undefined;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await safeFetch(`https://${d.domain}${d.pathPrefix ?? ""}/`, { signal: controller.signal, policy });
    clearTimeout(timeout);
    reachable = res.status < 500;
    statusCode = res.status;
  } catch {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await safeFetch(`http://${d.domain}${d.pathPrefix ?? ""}/`, { signal: controller.signal, policy });
      clearTimeout(timeout);
      reachable = res.status < 500;
      statusCode = res.status;
    } catch (httpErr) {
      error = httpErr instanceof Error ? httpErr.message : String(httpErr);
    }
  }

  const responseTimeMs = Date.now() - startTime;

  await db.insert(domainChecks).values({
    id: nanoid(),
    domainId: d.id,
    reachable,
    statusCode: statusCode ?? null,
    responseTimeMs,
    error: error ?? null,
  });

  if
 (!reachable && (!prevCheck || prevCheck.reachable)) {
    log.warn(
      `${d.domain} (app: ${d.app.name}) is unreachable` +
        (error ? ` — ${error}` : "") +
        (statusCode ? ` (HTTP ${statusCode})` : ""),
    );
  }

  return {
    domainId: d.id,
    domain: d.domain,
    appName: d.app.name,
    reachable,
    statusCode,
    responseTimeMs,
    error,
  };
}
