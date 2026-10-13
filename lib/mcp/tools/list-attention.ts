import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildAttentionRows } from "@/lib/attention/rows";
import type { McpAuthContext } from "../auth";
import { accessDenied, accessibleOrgIds, canAdminInstance, orgLabels } from "../scope";
import { clampLimit, limitArg, text } from "./result";

const ITEMS_PER_ROW = 10;

export function registerListAttention(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_list_attention",
    "List what needs attention now in each organization the token can reach: failing deploys, down apps, failed or overdue backups, unreachable domains and the like, grouped by problem. Pass includeInfo for routine notices too, organizationId for one org.",
    {
      organizationId: z.string().optional().describe("Only this organization"),
      includeInfo: z.boolean().default(false).describe("Include informational rows such as image updates"),
      limit: limitArg,
    },
    async ({ organizationId, includeInfo, limit }) => {
      const reachable = await accessibleOrgIds(context, "org.view");
      const orgIds = organizationId ? reachable.filter((id) => id === organizationId) : reachable;
      if (organizationId && orgIds.length === 0) return accessDenied("Organization");

      const isAppAdmin = await canAdminInstance(context);
      const labels = await orgLabels(orgIds);
      const cap = clampLimit(limit);

      const organizations = await Promise.all(
        orgIds.map(async (orgId) => {
          const rows = (await buildAttentionRows(orgId, { isAppAdmin })).filter(
            (row) => includeInfo || row.tone === "error" || row.tone === "warning",
          );
          return {
            organization: labels.get(orgId) ?? { id: orgId },
            rowCount: rows.length,
            rows: rows.slice(0, cap).map((row) => ({
              key: row.key,
              label: row.label,
              tone: row.tone,
              group: row.group ?? null,
              note: row.footer ?? null,
              itemCount: row.items.length,
              items: row.items.slice(0, ITEMS_PER_ROW).map((item) => ({
                name: item.name,
                where: item.where ?? null,
                detail: item.detail ?? null,
                since: item.since ?? null,
                urgent: item.urgent ?? false,
              })),
            })),
          };
        }),
      );

      return text({ organizations });
    },
  );
}
