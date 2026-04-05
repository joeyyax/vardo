import { logger } from "@/lib/logger";

const log = logger.child("domain-monitoring");

export async function registerDomainMonitoringPlugin(): Promise<void> {
  let ticking = false;
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      const { checkAllDomains } = await import("@/lib/domain-monitoring/monitor");
      await checkAllDomains();
    } catch (err) {
      log.error("Domain check error:", err);
    } finally {
      ticking = false;
    }
  }, 5 * 60 * 1000);

  log.info("Domain monitoring started (checking every 5 minutes)");
}
