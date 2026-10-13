import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ADMIN_FORBIDDEN_MESSAGE } from "@/lib/auth/admin-error";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { deleteBackups } from "@/lib/backups/delete-backups";
import { findRetiredArchives } from "@/lib/backups/retired-archives";
import type { McpAuthContext } from "../auth";
import { canAdminInstance } from "../scope";
import { failure, text } from "./result";

/** Registered only for a token with the admin scope. */
export function registerDeleteRetiredBackups(server: McpServer, context: McpAuthContext) {
  if (!context.adminScope) return;

  server.tool(
    "vardo_delete_retired_backups",
    "Delete backups in the retired .enc format, across every org and the system database. Only deletes a job's volume once it has a successful .age backup; the rest are listed as kept. Dry run unless dryRun is false. Needs a token with the admin scope.",
    {
      dryRun: z.boolean().default(true).describe("List what would be deleted without deleting it"),
    },
    async ({ dryRun }) => {
      if (!(await canAdminInstance(context))) return failure(ADMIN_FORBIDDEN_MESSAGE);
      if (!(await isFeatureEnabledAsync("backups"))) return failure("Backups are turned off on this instance");

      const { jobs, deletable } = await findRetiredArchives();
      const result = dryRun ? { deleted: 0, kept: 0 } : await deleteBackups(deletable);
      return text({
        dryRun,
        deletable: deletable.length,
        deleted: result.deleted,
        failed: result.kept,
        jobs,
      });
    },
  );
}
