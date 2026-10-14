// Moves a waiting deploy to the front of its queue: the deploy-slot line or the builder's.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { bumpBuild } from "@/lib/docker/build-gate";
import { lockClaims } from "./queue";
import { markQueueWaits } from "./waiting";

const log = logger.child("deploy-bump");

/** Which queue the deploy moved to the front of, or null when it isn't waiting in one. */
export type BumpOutcome = "deploy" | "build" | null;

/**
 * A queued deploy goes first in claim order, still behind its own app's running deploy.
 * A running deploy waiting for the builder moves to the head of the builder queue.
 */
export async function bumpDeploy(id: string): Promise<BumpOutcome> {
  const [queued] = await db.transaction(async (tx) => {
    await lockClaims(tx);
    return tx
      .update(deployments)
      .set({ bumpedAt: sql`now()` })
      .where(and(eq(deployments.id, id), eq(deployments.status, "queued")))
      .returning({ id: deployments.id });
  });
  if (queued) {
    await markQueueWaits().catch((err) => log.warn("Couldn't recompute queue waits after a bump:", err));
    return "deploy";
  }

  const [building] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.id, id), eq(deployments.status, "running"), eq(deployments.waitReason, "build-slot")));
  // Builder waiters read their new place on their next poll.
  if (building && (await bumpBuild(id))) return "build";
  return null;
}
