// One handling per GitHub delivery id, whether it arrived from GitHub or through a linked instance.

import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";

const log = logger.child("webhook");

/** How long a delivery id is remembered. GitHub's manual redelivery reuses the id, so it's skipped inside this window. */
export const DELIVERY_TTL_SECONDS = 60 * 60;

/** True the first time this instance sees `deliveryId`. Fails open when Redis is down. */
export async function claimDelivery(deliveryId: string | null): Promise<boolean> {
  if (!deliveryId) return true;
  try {
    const set = await redis.set(`github:delivery:${deliveryId}`, "1", "EX", DELIVERY_TTL_SECONDS, "NX");
    return set === "OK";
  } catch (err) {
    log.warn(`Couldn't record delivery ${deliveryId}; handling it anyway:`, err);
    return true;
  }
}
