import { registerInternalHandler } from "@/lib/hooks/registry";
import { logger } from "@/lib/logger";

const log = logger.child("security");

export async function registerSecurityPlugin(): Promise<void> {
  registerInternalHandler("security-scanner:run-scan", async (context) => {
    try {
      const { runSecurityScan } = await import("@/lib/security/scanner");
      await runSecurityScan({
        appId: context.appId as string,
        organizationId: context.organizationId as string,
        trigger: "deploy",
      });
      return { allowed: true, reason: "Security scan completed" };
    } catch (err) {
      return { allowed: true, reason: `Security scan failed: ${err}` };
    }
  });

  log.info("Security hooks registered");
}
