import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { backupJobs } from "@/lib/db/schema";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { startManualBackup } from "@/lib/backups/manual-run";
import { logger } from "@/lib/logger";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAccessOrg } from "../scope";
import { failure, text } from "./result";

const log = logger.child("mcp:run-backup");

export function registerRunBackup(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_run_backup",
    "Start a backup job now, as the backups page's run button does. Returns once it starts; follow it with vardo_list_backups. Get job IDs from vardo_list_backup_jobs.",
    {
      jobId: z.string().describe("The backup job ID"),
    },
    async ({ jobId }) => {
      if (!(await isFeatureEnabledAsync("backups"))) return failure("Backups are turned off on this instance");

      const job = await db.query.backupJobs.findFirst({
        where: eq(backupJobs.id, jobId),
        columns: { id: true, organizationId: true },
      });
      if (!job?.organizationId || !(await canAccessOrg(context, job.organizationId, "backup.run"))) {
        return accessDenied("Backup job");
      }

      const startedAt = new Date();
      const start = await startManualBackup(job.id);
      if (!start.started) return failure("This backup job is already running");
      start.done.catch((err) => {
        log.error(`Manual backup failed for job ${job.id}:`, err);
      });

      return text({ status: "started", jobId: job.id, startedAt: startedAt.toISOString() });
    },
  );
}
