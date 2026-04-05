import { registerInternalHandler } from "@/lib/hooks/registry";
import { logger } from "@/lib/logger";

const log = logger.child("backups");

export async function registerBackupsPlugin(): Promise<void> {
  // Register the internal hook handler for auto-backup creation
  registerInternalHandler("backups:ensure-auto-backup", async (context) => {
    try {
      const { ensureAutoBackupJob } = await import("@/lib/backups/auto-backup");
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

  log.info("Backups hooks registered");
}
