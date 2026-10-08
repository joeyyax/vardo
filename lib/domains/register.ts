import { logger } from "@/lib/logger";

const log = logger.child("domain-verification");

const INTERVAL_MS = 60 * 60 * 1000;

/** Re-checks domain ownership challenges hourly. */
export async function registerDomainVerificationPlugin(): Promise<void> {
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const { recheckDomainOwnership } = await import("@/lib/domains/recheck");
      await recheckDomainOwnership();
    } catch (err) {
      log.error("Domain verification error:", err);
    } finally {
      ticking = false;
    }
  };
  setInterval(tick, INTERVAL_MS);
  log.info("Domain verification started (checking hourly)");
}
