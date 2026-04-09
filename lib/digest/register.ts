import { isFeatureEnabled } from "@/lib/config/features";
import { logger } from "@/lib/logger";

const log = logger.child("digest");

export async function registerDigestPlugin(): Promise<void> {
  if (!isFeatureEnabled("digest")) {
    log.info("Digest disabled, skipping registration");
    return;
  }

  try {
    const { startDigestScheduler } = await import("@/lib/digest/scheduler");
    startDigestScheduler();
    log.info("Digest scheduler started");
  } catch (err) {
    log.error("Failed to start digest scheduler:", err);
  }
}
