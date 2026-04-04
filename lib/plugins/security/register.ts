import { registerPlugin } from "@/lib/plugins/registry";
import { registerInternalHandler } from "@/lib/hooks/registry";
import manifest from "./manifest";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:security");

export async function registerSecurityPlugin(): Promise<void> {
  await registerPlugin(manifest);

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

  log.info("Security scanner plugin registered");
}
