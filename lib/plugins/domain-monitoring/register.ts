import { registerPlugin } from "@/lib/plugins/registry";
import manifest from "./manifest";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:domain-monitoring");

export async function registerDomainMonitoringPlugin(): Promise<void> {
  await registerPlugin(manifest);

  // Start periodic domain health checks
  let ticking = false;
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      const { checkAllDomains } = await import("@/lib/domains/monitor");
      await checkAllDomains();
    } catch (err) {
      log.error("Domain check error:", err);
    } finally {
      ticking = false;
    }
  }, 5 * 60 * 1000);

  log.info("Domain monitoring plugin registered (checking every 5 minutes)");
}
