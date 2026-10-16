import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { backups } from "@/lib/db/schema";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { runManualDrill } from "@/lib/backups/manual-run";
import { backupOwnerOrgId, findDrillableBackup } from "@/lib/backups/org-backup";
import { logger } from "@/lib/logger";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAccessOrg, canAdminInstance } from "../scope";
import { failure, text } from "./result";

const log = logger.child("mcp:drill-backup");

const SYSTEM_BACKUP_UNSUPPORTED = "Restore drills don't cover the system database's backups";

export function registerDrillBackup(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_drill_backup",
    "Start a restore drill on one successful app backup, as the backups page's drill button does. Restores into scratch and never touches live data. Returns at once and runs when a backup slot is free; the verdict lands on the backup as verifiedAt and verifyOutcome in vardo_list_backups. Get backup IDs from vardo_list_backups.",
    {
      backupId: z.string().describe("The backup ID"),
    },
    async ({ backupId }) => {
      if (!(await isFeatureEnabledAsync("backups"))) return failure("Backups are turned off on this instance");

      const backup = await db.query.backups.findFirst({
        where: eq(backups.id, backupId),
        columns: { id: true, appId: true, organizationId: true },
        with: { app: { columns: { organizationId: true } } },
      });
      if (!backup) return accessDenied("Backup");

      if (!backup.appId && !backup.organizationId) {
        return (await canAdminInstance(context)) ? failure(SYSTEM_BACKUP_UNSUPPORTED) : accessDenied("Backup");
      }

      const orgId = backupOwnerOrgId(backup);
      if (!orgId || !(await canAccessOrg(context, orgId, "backup.run"))) return accessDenied("Backup");

      const drillable = await findDrillableBackup(orgId, backupId);
      if (!drillable.ok) {
        return drillable.reason === "not_found"
          ? accessDenied("Backup")
          : failure("Only a successful backup can be drilled");
      }

      void runManualDrill(backupId).catch((err) => {
        log.error(`Restore drill failed for backup ${backupId}:`, err);
      });

      return text({ status: "started", backupId });
    },
  );
}
