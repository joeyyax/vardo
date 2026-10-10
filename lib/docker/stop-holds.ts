// Containers Vardo stopped on purpose. Self-heal skips them until released, in any process.

import { eq, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { containerHolds } from "@/lib/db/schema";

/** Long enough for a large restore; a hold its owner never released lapses on its own. */
export const HOLD_TTL_MS = 24 * 60 * 60_000;

/** Mark a container as deliberately stopped, with who stopped it. */
export async function holdStopped(containerId: string, holder: string, ttlMs = HOLD_TTL_MS): Promise<void> {
  const expiresAt = sql`now() + ${ttlMs}::int * interval '1 millisecond'`;
  await db.delete(containerHolds).where(lte(containerHolds.expiresAt, sql`now()`));
  await db
    .insert(containerHolds)
    .values({ containerId, holder, expiresAt })
    .onConflictDoUpdate({ target: containerHolds.containerId, set: { holder, expiresAt } });
}

export async function releaseStopped(containerId: string): Promise<void> {
  await db.delete(containerHolds).where(eq(containerHolds.containerId, containerId));
}

/** Holder of a stopped container, matched on either the full or the short id. */
export async function stopHolder(containerId: string): Promise<string | null> {
  const [row] = await db
    .select({ holder: containerHolds.holder })
    .from(containerHolds)
    .where(
      sql`${containerHolds.expiresAt} > now() AND (starts_with(${containerHolds.containerId}, ${containerId}) OR starts_with(${containerId}, ${containerHolds.containerId}))`,
    )
    .limit(1);
  return row?.holder ?? null;
}
