import { db } from "@/lib/db";
import { domainChecks } from "@/lib/db/schema";
import { eq, and, desc, asc } from "drizzle-orm";
import { nanoid } from "nanoid";

type DomainCheckResult = {
  domainId: string;
  domain: string;
  appName: string;
  reachable: boolean;
  statusCode?: number;
  responseTimeMs: number;
  error?: string;
};

/**
 * Check all domains across all active apps.
 * Call this from a scheduled interval (e.g. every 5 minutes).
 */
export async function checkAllDomains(): Promise<DomainCheckResult[]> {
  const allDomains = await db.query.domains.findMany({
    with: {
      app: {
        columns: { id: true, name: true, status: true },
      },
    },
  });

  const results: DomainCheckResult[] = [];

  for (const d of allDomains) {
    // Skip domains for non-active apps
    if (d.app.status !== "active") continue;
    // Skip localhost domains
    if (d.domain.includes("localhost")) continue;

    const startTime = Date.now();
    let reachable = false;
    let statusCode: number | undefined;
    let error: string | undefined;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`https://${d.domain}/`, {
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timeout);
      reachable = res.status < 500;
      statusCode = res.status;
    } catch {
      // Try HTTP fallback
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`http://${d.domain}/`, {
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timeout);
        reachable = res.status < 500;
        statusCode = res.status;
      } catch (httpErr) {
        error = httpErr instanceof Error ? httpErr.message : String(httpErr);
      }
    }

    const responseTimeMs = Date.now() - startTime;

    const result: DomainCheckResult = {
      domainId: d.id,
      domain: d.domain,
      appName: d.app.name,
      reachable,
      statusCode,
      responseTimeMs,
      error,
    };

    results.push(result);

    // Store the check result
    await db.insert(domainChecks).values({
      id: nanoid(),
      domainId: d.id,
      reachable,
      statusCode: statusCode ?? null,
      responseTimeMs,
      error: error ?? null,
    });

    // Detect state transitions for notifications
    if (!reachable) {
      // Check if the previous check was successful (transition to failure)
      const previousCheck = await db.query.domainChecks.findFirst({
        where: eq(domainChecks.domainId, d.id),
        orderBy: [desc(domainChecks.checkedAt)],
        // Skip the one we just inserted by getting the second most recent
      });

      // Get the second most recent check (the one before our insert)
      const recentChecks = await db.query.domainChecks.findMany({
        where: eq(domainChecks.domainId, d.id),
        orderBy: [desc(domainChecks.checkedAt)],
        limit: 2,
      });

      const prevCheck = recentChecks.length > 1 ? recentChecks[1] : null;

      if (!prevCheck || prevCheck.reachable) {
        console.log(
          `[domain-monitor] WARNING: ${d.domain} (app: ${d.app.name}) is unreachable` +
            (error ? ` — ${error}` : "") +
            (statusCode ? ` (HTTP ${statusCode})` : "")
        );
      }
    }

    // Prune old checks — keep only the last 100 per domain
    try {
      const oldChecks = await db.query.domainChecks.findMany({
        where: eq(domainChecks.domainId, d.id),
        orderBy: [desc(domainChecks.checkedAt)],
        columns: { id: true },
        offset: 100,
      });

      if (oldChecks.length > 0) {
        for (const old of oldChecks) {
          await db.delete(domainChecks).where(eq(domainChecks.id, old.id));
        }
      }
    } catch {
      // Pruning is best-effort
    }
  }

  return results;
}
