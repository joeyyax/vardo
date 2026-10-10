import { isFeatureEnabled } from "@/lib/config/features";
import { logger } from "@/lib/logger";

const log = logger.child("monitoring");

/** One-off monitoring work at boot. Its loops run from the loop registry. */
export async function registerMonitoringPlugin(): Promise<void> {
  if (!isFeatureEnabled("monitoring")) {
    log.info("Monitoring disabled, skipping registration");
    return;
  }

  // Audits stored compose configs for silently ignored settings.
  import("@/lib/docker/compose-audit")
    .then(({ reportStoredComposeConfigs }) => reportStoredComposeConfigs())
    .catch((err) => log.warn("Compose audit failed to start:", err));
}
