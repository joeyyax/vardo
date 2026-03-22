import { db } from "@/lib/db";
import { domainChecks } from "@/lib/db/schema";
import { eq, desc, lt, and } from "drizzle-orm";
import { nanoid } from "nanoid";

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

/**
 * Check all domains across all active apps.
 * Probes up to MAX_CONCURRENCY domains in parallel.
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

  const eligible = allDomains.filter(
    (d) => d.app.status === "active" && !d.domain.includes("localhost"),
  );

  if (eligible.length === 0) return [];

  // Query previous check state for all domains in one go (for state transition detection)
  const prevChecks = await db.query.domainChecks.findMany({
    orderBy: [desc(domainChecks.checkedAt)],
  });
  const prevByDomain = new Map<string, typeof prevChecks[0]>();
  for (const check of prevChecks) {
    if (!prevByDomain.has(check.domainId)) {
      prevByDomain.set(check.domainId, check);
    }
  }

  // Semaphore for concurrency limiting
  let running = 0;
  let resolveSlot: (() => void) | null = null;

  async function acquireSlot() {
    while (running >= MAX_CONCURRENCY) {
      await new Promise<void>((r) => { resolveSlot = r; });
    }
    running++;
  }

  function releaseSlot() {
    running--;
    if (resolveSlot) {
      const r = resolveSlot;
      resolveSlot = null;
      r();
    }
  }

  const results = await Promise.allSettled(
    eligible.map(async (d) => {
      await acquireSlot();
      try {
        return await probeDomain(d, prevByDomain.get(d.id));
      } finally {
        releaseSlot();
      }
    }),
  );

  const checks: DomainCheckResult[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") checks.push(r.value);
  }

  // Batch prune old checks — delete anything beyond the 100 most recent per domain
  try {
    for (const d of eligible) {
      const cutoff = await db.query.domainChecks.findFirst({
        where: eq(domainChecks.domainId, d.id),
        orderBy: [desc(domainChecks.checkedAt)],
        columns: { checkedAt: true },
        offset: 99,
      });
      if (cutoff?.checkedAt) {
        await db
          .delete(domainChecks)
          .where(
            and(
              eq(domainChecks.domainId, d.id),
              lt(domainChecks.checkedAt, cutoff.checkedAt),
            ),
          );
      }
    }
  } catch {
    // Pruning is best-effort
  }

  return checks;
}

async function probeDomain(
  d: { id: string; domain: string; app: { name: string } },
  prevCheck: { reachable: boolean } | undefined,
): Promise<DomainCheckResult> {
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

  // Store the check result
  await db.insert(domainChecks).values({
    id: nanoid(),
    domainId: d.id,
    reachable,
    statusCode: statusCode ?? null,
    responseTimeMs,
    error: error ?? null,
  });

  // State transition detection — compare against previous check (queried before probes started)
  if (!reachable && (!prevCheck || prevCheck.reachable)) {
    console.log(
      `[domain-monitor] WARNING: ${d.domain} (app: ${d.app.name}) is unreachable` +
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
