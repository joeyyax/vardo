import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EMPTY_FILTERS } from "@/lib/activity/filter";
import { listActivities } from "@/lib/app-services/activity";
import type { McpAuthContext } from "../auth";
import { accessibleActors, serviceErrorResult } from "../actors";
import { accessDenied } from "../scope";
import { clampLimit, iso, limitArg, text } from "./result";

export function registerListActivity(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_list_activity",
    "List the organization activity feed, newest first: action, family, outcome, who did it, which app and when. Pass appId for one app, organizationId for one org. A cross-org token lists every organization it reaches.",
    {
      appId: z.string().optional().describe("Only this app's activity"),
      organizationId: z.string().optional().describe("Only this organization"),
      limit: limitArg,
    },
    async ({ appId, organizationId, limit }) => {
      const reachable = await accessibleActors(context, "org.view");
      const actors = organizationId ? reachable.filter((a) => a.org.id === organizationId) : reachable;
      if (organizationId && actors.length === 0) return accessDenied("Organization");

      const cap = clampLimit(limit);
      try {
        const perOrg = await Promise.all(
          actors.map(async (actor) => {
            const { activities, total } = await listActivities(actor, { filters: EMPTY_FILTERS, appId, limit: cap });
            return {
              organization: { id: actor.org.id, name: actor.org.name, slug: actor.org.slug },
              total,
              activities: activities.map((a) => ({
                id: a.id,
                action: a.action,
                family: a.family ?? null,
                outcome: a.outcome ?? null,
                at: iso(a.createdAt),
                user: a.user?.name ?? null,
                app: a.app ? { id: a.app.id, name: a.app.displayName } : null,
              })),
            };
          }),
        );
        return text({ organizations: perOrg });
      } catch (err) {
        return serviceErrorResult(err, "Activity");
      }
    },
  );
}
