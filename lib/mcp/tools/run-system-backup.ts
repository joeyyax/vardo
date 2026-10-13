import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ADMIN_FORBIDDEN_MESSAGE } from "@/lib/auth/admin-error";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { startManualBackup } from "@/lib/backups/manual-run";
import { findSystemJob } from "@/lib/backups/system-storage";
import { logger } from "@/lib/logger";
import type { McpAuthContext } from "../auth";
import { canAdminInstance } from "../scope";
import { failure, text } from "./result";

const log = logger.child("mcp:run-system-backup");

/** Registered only for a token with the admin scope. */
export function registerRunSystemBackup(server: McpServer, context: McpAuthContext) {
  if (!context.adminScope) return;

  server.tool(
    "vardo_run_system_backup",
    "Start a backup of Vardo's own database now, as the System backup page's run button does. Returns once it starts; the last run shows as systemDatabaseJob in vardo_list_backup_jobs. Needs a token with the admin scope.",
    {},
    async () => {
      if (!(await canAdminInstance(context))) return failure(ADMIN_FORBIDDEN_MESSAGE);
      if (!(await isFeatureEnabledAsync("backups"))) return failure("Backups are turned off on this instance");

      const job = await findSystemJob();
      if (!job) return failure("No system backup job is set up");

      const startedAt = new Date();
      const start = await startManualBackup(job.id);
      if (!start.started) return failure("The system backup is already running");
      start.done.catch((err) => {
        log.error(`Manual system backup failed for job ${job.id}:`, err);
      });

      return text({ status: "started", jobId: job.id, startedAt: startedAt.toISOString() });
    },
  );
}
