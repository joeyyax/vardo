// MCP domain tools. Every write runs through lib/domains/manage so a route added
// here behaves exactly like one added through the API or the UI.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains } from "@/lib/db/schema";
import { CERT_RESOLVERS } from "@/lib/system-settings";
import { parseMiddlewares } from "@/lib/domains/middlewares";
import {
  addDomain,
  createDomainSchema,
  editDomain,
  removeDomain,
  setPrimaryDomain,
  updateDomainSchema,
  type DomainResult,
} from "@/lib/domains/manage";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAccessOrg } from "../scope";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (error: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
  isError: true as const,
});

/** A route change only reaches Traefik when the app deploys. */
const DEPLOY_NOTE =
  "The app needs a deploy for this to take effect: run vardo_deploy_app, or set VARDO_DEPLOY_ON_PUSH so a push rebuilds it.";

/** The app a domain belongs to, with the flags the guards read. */
async function findApp(appId: string) {
  return db.query.apps.findFirst({
    where: eq(apps.id, appId),
    columns: { id: true, organizationId: true, isSystemManaged: true },
  });
}

/** What a domain write did, in the tool's own words. */
function outcome(result: DomainResult, note = DEPLOY_NOTE) {
  if (!result.ok) return failure(result.error);
  if (result.kind === "removed") return text({ removed: result.domainId, note });
  const domain = viewDomain(result.domain);
  const pending = note === DEPLOY_NOTE && result.domain.verifiedAt === null
    ? " Vardo only routes a host once it has proved ownership: the route appears after that check passes."
    : "";
  return text({ domain, note: `${note}${pending}` });
}

/** The app's domains, minus the proof token, with middlewares as a list. */
function viewDomain(row: typeof domains.$inferSelect) {
  const { verificationToken: _token, ...rest } = row;
  return { ...rest, middlewares: parseMiddlewares(row.middlewares) };
}

export function registerDomainTools(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_list_domains",
    "List an app's domains: the host, the path it's limited to, its port and service, certificate resolver, redirects, middlewares, which one is primary, and whether Vardo or the app's compose file owns it.",
    {
      appId: z.string().describe("The app whose domains to list"),
      domainId: z.string().optional().describe("Only this domain"),
    },
    async ({ appId, domainId }) => {
      const app = await findApp(appId);
      if (!app || !(await canAccessOrg(context, app.organizationId, "app.view"))) return accessDenied("App");

      const rows = await db.query.domains.findMany({
        where: and(eq(domains.appId, appId), ...(domainId ? [eq(domains.id, domainId)] : [])),
        orderBy: (d, { asc }) => [asc(d.domain)],
      });
      if (domainId && rows.length === 0) return failure("That domain isn't on this app.");

      return text({
        domains: rows.map(viewDomain),
        readOnly: rows.filter((d) => d.source === "compose").map((d) => d.domain),
      });
    }
  );

  server.tool(
    "vardo_add_domain",
    "Add a domain to an app and route it through Traefik. Vardo owns the record it creates, so updates and removals work here; a host the app's compose file declares stays read-only in Vardo.",
    {
      appId: z.string().describe("The app to route to"),
      domain: z.string().describe('The host, e.g. "join.example.com"'),
      serviceName: z
        .string()
        .optional()
        .describe("Compose service to route to, when the app runs more than one"),
      port: z.number().int().positive().optional().describe("Container port the host routes to"),
      certResolver: z.enum(CERT_RESOLVERS).optional().describe("Certificate resolver (default: the instance's primary issuer)"),
      redirectTo: z.string().url().optional().describe("Send this host somewhere else instead of routing to the app"),
      redirectCode: z.union([z.literal(301), z.literal(302)]).optional().describe("Redirect status (default 301)"),
      pathPrefix: z.string().optional().describe('Route only requests under this path, e.g. "/docs"'),
      stripPathPrefix: z.boolean().optional().describe("Remove the path prefix before the request reaches the app"),
      middlewares: z.array(z.string()).optional().describe('Traefik middleware references, e.g. ["cloudflare-only@file"]'),
    },
    async ({ appId, ...input }) => {
      const app = await findApp(appId);
      if (!app || !(await canAccessOrg(context, app.organizationId, "app.domains"))) return accessDenied("App");

      const parsed = createDomainSchema.safeParse(input);
      if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Invalid input");

      return outcome(await addDomain(app, parsed.data));
    }
  );

  server.tool(
    "vardo_update_domain",
    "Change a Vardo-managed domain: its host, port, service, resolver, redirect, path prefix or middlewares. Pass null to clear a port, redirect or path prefix. Renaming the host starts verification over.",
    {
      appId: z.string().describe("The app the domain belongs to"),
      domainId: z.string().describe("The domain ID from vardo_list_domains"),
      domain: z.string().optional().describe("New host"),
      port: z.number().int().positive().nullable().optional().describe("Container port, or null to use the service default"),
      certResolver: z.enum(CERT_RESOLVERS).optional().describe("Certificate resolver"),
      redirectTo: z.string().url().nullable().optional().describe("Redirect target, or null to route to the app again"),
      redirectCode: z.union([z.literal(301), z.literal(302)]).optional().describe("Redirect status"),
      pathPrefix: z.string().nullable().optional().describe('Path the host is limited to, or null for the whole host'),
      stripPathPrefix: z.boolean().optional().describe("Remove the path prefix before the request reaches the app"),
      middlewares: z.array(z.string()).nullable().optional().describe("Traefik middleware references, or null for none. Replaces the stored list"),
    },
    async ({ appId, domainId, ...fields }) => {
      const app = await findApp(appId);
      if (!app || !(await canAccessOrg(context, app.organizationId, "app.domains"))) return accessDenied("App");

      const parsed = updateDomainSchema.safeParse({ id: domainId, ...fields });
      if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Invalid input");

      return outcome(await editDomain(app, parsed.data));
    }
  );

  server.tool(
    "vardo_remove_domain",
    "Remove a Vardo-managed domain and the route it holds. Compose-declared domains are read-only here: change their Traefik label in the app's compose file.",
    {
      appId: z.string().describe("The app the domain belongs to"),
      domainId: z.string().describe("The domain ID from vardo_list_domains"),
    },
    async ({ appId, domainId }) => {
      const app = await findApp(appId);
      if (!app || !(await canAccessOrg(context, app.organizationId, "app.domains"))) return accessDenied("App");

      return outcome(await removeDomain(app, domainId));
    }
  );

  server.tool(
    "vardo_set_primary_domain",
    "Choose the domain the app is known by: its URL in the dashboard and the VARDO_URL and VARDO_DOMAIN environment inside the container.",
    {
      appId: z.string().describe("The app the domain belongs to"),
      domainId: z.string().describe("The domain ID from vardo_list_domains"),
    },
    async ({ appId, domainId }) => {
      const app = await findApp(appId);
      if (!app || !(await canAccessOrg(context, app.organizationId, "app.domains"))) return accessDenied("App");

      return outcome(
        await setPrimaryDomain(app, domainId),
        "Deploy the app so its URL environment picks up the new primary domain."
      );
    }
  );
}
