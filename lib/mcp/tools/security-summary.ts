import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { guardHistory } from "@/lib/probe-guard/history";
import { listActiveBans } from "@/lib/probe-guard/bans";
import { GUARD_RANGES } from "@/lib/probe-guard/range";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAdminInstance, resolveAppOrg } from "../scope";
import { clampLimit, failure, iso, limitArg, text } from "./result";

const ACTIVE_BAN_COUNT_CAP = 500;
const CATEGORIES_PER_BAN = 3;

export function registerSecuritySummary(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_security_summary",
    "Probe guard overview for a time range: probes, bans and trap hits, active ban count, recent bans with what each address probed, top probed categories and top sources. Pass appId for one app; instance-wide needs a token with the admin scope.",
    {
      appId: z.string().optional().describe("One app. Omit for the whole instance (admin scope)"),
      range: z.enum(GUARD_RANGES).default("7d").describe("Time range (default 7d)"),
      limit: limitArg,
    },
    async ({ appId, range, limit }) => {
      if (appId) {
        if (!(await resolveAppOrg(context, appId, "app.view"))) return accessDenied("App");
      } else if (!(await canAdminInstance(context))) {
        return failure("Instance-wide security needs a token with the admin scope. Pass appId for one app.");
      }

      const cap = clampLimit(limit);
      const [history, active] = await Promise.all([
        guardHistory({ range, appId }),
        listActiveBans({ appId, limit: ACTIVE_BAN_COUNT_CAP }),
      ]);

      return text({
        range: history.label,
        since: iso(history.since),
        stats: history.stats,
        activeBans: { count: active.length, capped: active.length >= ACTIVE_BAN_COUNT_CAP },
        recentBans: history.bans.slice(0, cap).map((b) => ({
          ip: b.ip,
          reason: b.reason,
          hits: b.hits,
          status: b.status.kind,
          appId: b.appId,
          createdAt: iso(b.createdAt),
          expiresAt: iso(b.expiresAt),
          blockedCount: b.blockedCount,
          probed: b.detail?.categories.slice(0, CATEGORIES_PER_BAN).map((c) => c.label) ?? [],
        })),
        probed: history.categories.slice(0, cap),
        topSources: history.sources,
        note: history.note,
      });
    },
  );
}
