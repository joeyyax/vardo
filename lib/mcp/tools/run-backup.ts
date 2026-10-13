import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { backupJobs } from "@/lib/db/schema";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { MANUAL_TRIGGER, runBackup, runSucceeded } from "@/lib/backups/engine";
import { redactSecrets } from "@/lib/redact";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAccessOrg } from "../scope";
import { failure, text } from "./result";

export function registerRunBackup(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_run_backup",
    "Run a backup job now, as the backups page's run button does. Waits for it to finish and returns success, the skipped count and each volume's outcome, size and error. Get job IDs from vardo_list_backup_jobs.",
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

      const results = await runBackup(job.id, { trigger: MANUAL_TRIGGER });

      return text({
        success: runSucceeded(results),
        skipped: results.filter((r) => r.outcome === "skipped").length,
        results: results.map((r) => ({
          backupId: r.backupId,
          appId: r.appId,
          volumeName: r.volumeName,
          outcome: r.outcome,
          sizeBytes: r.sizeBytes,
          durationMs: r.durationMs,
          error: r.error ? redactSecrets(r.error) : null,
        })),
      });
    },
  );
}
