import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, inArray, notInArray, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { redactSecrets } from "@/lib/redact";
import type { McpAuthContext } from "../auth";
import { accessibleOrgIds, orgFilter } from "../scope";
import { clampLimit, iso, limitArg, text } from "./result";

const STATUSES = ["queued", "running", "success", "failed", "cancelled", "rolled_back", "superseded"] as const;
const ACTIVE = ["queued", "running"] as const;
const SNIPPET = 160;

const snippet = (value: string | null) => (value ? redactSecrets(value).slice(0, SNIPPET) : null);

export function registerListDeployments(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_list_deployments",
    "List deployments across the apps the token can reach: running and queued first, then recent ones, with app, status, trigger, commit, duration and times. Filter by status or appId. Use vardo_get_deploy_logs for a log.",
    {
      status: z.enum(STATUSES).optional().describe("Only deployments in this status"),
      appId: z.string().optional().describe("Only this app's deployments"),
      limit: limitArg,
    },
    async ({ status, appId, limit }) => {
      const orgIds = await accessibleOrgIds(context, "app.view");
      const cap = clampLimit(limit);

      const select = (...filters: (SQL | undefined)[]) =>
        db
          .select({
            id: deployments.id,
            status: deployments.status,
            trigger: deployments.trigger,
            gitSha: deployments.gitSha,
            gitMessage: deployments.gitMessage,
            durationMs: deployments.durationMs,
            postDeployError: deployments.postDeployError,
            rollbackFromId: deployments.rollbackFromId,
            startedAt: deployments.startedAt,
            finishedAt: deployments.finishedAt,
            appId: apps.id,
            appName: apps.displayName,
            organizationId: apps.organizationId,
          })
          .from(deployments)
          .innerJoin(apps, eq(deployments.appId, apps.id))
          .where(and(orgFilter(apps.organizationId, orgIds), appId ? eq(deployments.appId, appId) : undefined, ...filters))
          .orderBy(desc(deployments.startedAt));

      let rows;
      if (status) {
        rows = await select(eq(deployments.status, status)).limit(cap);
      } else {
        const active = await select(inArray(deployments.status, [...ACTIVE])).limit(cap);
        const recent =
          active.length < cap ? await select(notInArray(deployments.status, [...ACTIVE])).limit(cap - active.length) : [];
        rows = [...active, ...recent];
      }

      return text({
        deployments: rows.map((d) => ({
          ...d,
          gitMessage: snippet(d.gitMessage),
          postDeployError: snippet(d.postDeployError),
          startedAt: iso(d.startedAt),
          finishedAt: iso(d.finishedAt),
        })),
        count: rows.length,
      });
    },
  );
}
