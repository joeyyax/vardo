import { db } from "@/lib/db";
import { domainChecks } from "@/lib/db/schema";
import { desc, inArray, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import pLimit from "p-limit";
import { logger } from "@/lib/logger";
import { safeFetch } from "@/lib/security/safe-fetch";
import { getDomainProbePolicy } from "@/lib/security/outbound-policy";
import type { OutboundPolicy } from "@/lib/security/ssrf";

const log = logger.child("domain-monitor");

const MAX_CONCURRENCY = 5;

/** Raw checks kept this long; the hourly rollup keeps the history. */
export const DOMAIN_CHECK_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Deletes checks older than the retention window, for every domain. */
export async function pruneDomainChecks(now = Date.now()): Promise<void> {
  await db.delete(domainChecks).where(lt(domainChecks.checkedAt, new Date(now - DOMAIN_CHECK_RETENTION_MS)));
}

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
  // Before the eligibility filter, so a stopped app's checks still age out.
  await pruneDomainChecks().catch(() => {});

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
    .selectDistinctOn([domainChecks.domainId], {
      domainId: domainChecks.domainId,
      reachable: domainChecks.reachable,
    })
    .from(domainChecks)
    .where(inArray(domainChecks.domainId, domainIds))
    .orderBy(domainChecks.domainId, desc(domainChecks.checkedAt))
    .then((rows) => new Map(rows.map((row) => [row.domainId, { reachable: row.reachable }])));

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
