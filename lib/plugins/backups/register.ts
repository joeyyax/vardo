import { registerPlugin } from "@/lib/plugins/registry";
import { registerInternalHandler } from "@/lib/hooks/registry";
import manifest from "./manifest";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:backups");

export async function registerBackupsPlugin(): Promise<void> {
  await registerPlugin(manifest);

  // Register the internal hook handler for auto-backup creation
  registerInternalHandler("backups:ensure-auto-backup", async (context) => {
    try {
      const { ensureAutoBackupJob } = await import("@/lib/backup/auto-backup");
      const jobId = await ensureAutoBackupJob({
        appId: context.appId as string,
        appName: context.appName as string,
        organizationId: context.organizationId as string,
      });
      return {
        allowed: true,
        reason: jobId ? "Auto-backup job created" : "Backup job already exists",
      };
    } catch (err) {
      return { allowed: true, reason: `Backup setup failed: ${err}` };
    }
  });

  log.info("Backups plugin registered");
}
