// Delete next release: keys the pre-queue sweeper reads while both slots run during a self-update.
// It cancels a queued row past 2 minutes without `deploy:worker:{id}` and fails a running one past its budget unless `deploy:active:{scope}` names it.

import { and, eq, isNotNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema";

/** The old code's lease and renewal on both keys. */
const TTL_MS = 30_000;
const QUEUED_RENEW_MS = 10_000;

const workerKey = (id: string) => `deploy:worker:${id}`;
const activeKey = (scope: string) => `deploy:active:${scope}`;

export type ActiveRow = { id: string; scopeKey: string; stage: string | null };

let queuedMarkedAt = 0;

/** Leases every queued row this code owns, at most every 10 seconds. */
export async function markQueuedForOldSweeper(now = Date.now()): Promise<void> {
  if (now - queuedMarkedAt < QUEUED_RENEW_MS) return;
  queuedMarkedAt = now;
  try {
    const rows = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.status, "queued"), or(isNotNull(deployments.scopeKey), isNotNull(deployments.request))));
    if (rows.length === 0) return;
    const { redis } = await import("@/lib/redis");
    const pipeline = redis.pipeline();
    for (const { id } of rows) pipeline.set(workerKey(id), "1", "PX", TTL_MS);
    await pipeline.exec();
  } catch {
    // The next pass retries within the lease.
  }
}

/** Names each running deploy as its scope's active deploy, in the old code's format. */
export async function markRunningForOldSweeper(rows: ActiveRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    const { redis } = await import("@/lib/redis");
    const pipeline = redis.pipeline();
    for (const row of rows) {
      pipeline.set(activeKey(row.scopeKey), JSON.stringify({ deploymentId: row.id, stage: row.stage ?? "clone" }), "PX", TTL_MS);
    }
    await pipeline.exec();
  } catch {
    // Expires on its own.
  }
}

/** Drops the scope's active entry while it still names this deploy. */
export async function clearRunningForOldSweeper(row: Pick<ActiveRow, "id" | "scopeKey">): Promise<void> {
  try {
    const { redis } = await import("@/lib/redis");
    const raw = await redis.get(activeKey(row.scopeKey));
    if (raw && (JSON.parse(raw) as { deploymentId?: string }).deploymentId === row.id) await redis.del(activeKey(row.scopeKey));
  } catch {
    // Expires on its own.
  }
}

/** Tests only. */
export function resetLegacyCompatForTests(): void {
  queuedMarkedAt = 0;
}
