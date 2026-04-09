import { registerInternalHandler } from "@/lib/hooks/registry";
import { isFeatureEnabled } from "@/lib/config/features";
import { logger } from "@/lib/logger";

const log = logger.child("ssl");

export async function registerSslPlugin(): Promise<void> {
  if (!isFeatureEnabled("ssl")) {
    log.info("SSL disabled, skipping registration");
    return;
  }

  registerInternalHandler("ssl:validate-domain", async (context) => {
    const domain = context.domain as string;
    if (!domain) {
      return { allowed: false, reason: "No domain provided" };
    }

    try {
      const { resolve4 } = await import("dns/promises");
      const addresses = await resolve4(domain);
      if (addresses.length === 0) {
        return { allowed: false, reason: `Domain ${domain} does not resolve to any IP address` };
      }
      return { allowed: true, reason: `Domain ${domain} resolves to ${addresses[0]}` };
    } catch {
      return { allowed: false, reason: `Domain ${domain} failed DNS resolution` };
    }
  });

  log.info("SSL hooks registered");
}
