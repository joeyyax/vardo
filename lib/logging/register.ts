import { isFeatureEnabled } from "@/lib/config/features";
import { logger } from "@/lib/logger";

const log = logger.child("logging");

export async function registerLoggingFeature(): Promise<void> {
  if (!isFeatureEnabled("logging")) {
    log.info("Logging disabled, skipping registration");
    return;
  }

  // Verify Loki is reachable so log queries work from the start.
  // Non-blocking — the client retries automatically on each request.
  try {
    const { isLokiAvailable } = await import("@/lib/logging/client");
    const ready = await isLokiAvailable();
    if (ready) {
      log.info("Loki connected");
    } else {
      log.warn("Loki not reachable — log queries will be unavailable until it starts");
    }
  } catch (err) {
    log.warn("Failed to check Loki availability:", err);
  }
}
