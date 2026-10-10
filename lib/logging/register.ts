import { isFeatureEnabled } from "@/lib/config/features";
import { logger } from "@/lib/logger";
import { SAMPLE_MS } from "@/lib/ui/error-rate";
import { IntervalLoop } from "@/lib/worker/interval-loop";

const log = logger.child("logging");

/** Checks Loki is reachable. Error rate sampling runs from the loop registry. */
export async function registerLoggingFeature(): Promise<void> {
  if (!isFeatureEnabled("logging")) {
    log.info("Logging disabled, skipping registration");
    return;
  }

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

export const errorRateLoop = new IntervalLoop({
  name: "error-rate",
  intervalMs: SAMPLE_MS,
  log,
  run: async () => {
    const { collectErrorRates } = await import("@/lib/logging/error-rate");
    await collectErrorRates();
  },
});
