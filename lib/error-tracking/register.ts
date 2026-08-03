import { isFeatureEnabled } from "@/lib/config/features";
import { logger } from "@/lib/logger";

const log = logger.child("error-tracking");

export async function registerErrorTrackingPlugin(): Promise<void> {
  if (!isFeatureEnabled("error-tracking")) {
    log.info("Error tracking disabled, skipping registration");
    return;
  }

  try {
    const { isGlitchTipAvailable } = await import("@/lib/error-tracking/client");
    const ready = await isGlitchTipAvailable();
    if (ready) {
      log.info("GlitchTip connected");
    } else {
      log.warn("GlitchTip did not answer — unreachable, or its API token is missing or rejected");
    }
  } catch (err) {
    log.warn("Failed to check GlitchTip availability:", err);
  }
}
