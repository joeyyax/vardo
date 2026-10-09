// Expires finished deploys' Redis streams. The persisted log in Postgres serves history after that.

import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema/apps";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { deployStream } from "./keys";

const log = logger.child("deploy-stream-expiry");

const PREFIX = deployStream("");

/** Twenty-four hours. */
export const DEPLOY_STREAM_TTL_MS = 24 * 60 * 60 * 1000;

const TERMINAL_STATUSES = ["success", "failed", "cancelled", "rolled_back", "superseded"] as const;

const SCAN_COUNT = 200;

/** Sets the finished-deploy expiry on a deploy's stream. */
export async function expireDeployStream(deployId: string): Promise<void> {
  await redis.pexpire(deployStream(deployId), DEPLOY_STREAM_TTL_MS);
}

/**
 * Sets the expiry on deploy streams that have none, when the deployment is finished or gone.
 * Returns the number of streams updated.
 */
export async function sweepDeployStreams(): Promise<number> {
  let cursor = "0";
  let expired = 0;

  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${PREFIX}*`, "COUNT", SCAN_COUNT);
    cursor = next;

    const persistent: string[] = [];
    for (const key of keys) {
      if ((await redis.pttl(key)) === -1) persistent.push(key);
    }
    if (persistent.length === 0) continue;

    const ids = persistent.map((key) => key.slice(PREFIX.length));
    const rows = await db
      .select({ id: deployments.id, status: deployments.status })
      .from(deployments)
      .where(inArray(deployments.id, ids));
    const statusById = new Map(rows.map((r) => [r.id, r.status]));

    for (const id of ids) {
      const status = statusById.get(id);
      // A missing row is a deleted deployment; nothing will write to its stream.
      if (status && !(TERMINAL_STATUSES as readonly string[]).includes(status)) continue;
      await expireDeployStream(id);
      expired++;
    }
  } while (cursor !== "0");

  log.info(`Set an expiry on ${expired} finished deploy stream(s)`);
  return expired;
}
