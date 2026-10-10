import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import { isInstanceAdminUser } from "@/lib/auth/system-org";
import type { McpAuthContext } from "@/lib/mcp/auth";
import type { Capability } from "@/lib/auth/permissions";
import { allows, type Actor } from "./actor";

/** An MCP token as an actor in `orgId`, or null when the token can't reach that org or lacks `cap` there. */
export async function mcpActor(context: McpAuthContext, orgId: string, cap: Capability): Promise<Actor | null> {
  const actor = await resolve(context, orgId);
  return actor && allows(actor, cap) ? actor : null;
}

async function resolve(context: McpAuthContext, orgId: string): Promise<Actor | null> {
  if (!context.crossOrg && orgId !== context.organizationId) return null;
  const membership = await db.query.memberships.findFirst({
    where: and(eq(memberships.userId, context.userId), eq(memberships.organizationId, orgId)),
    columns: { id: true, role: true },
    with: { organization: true },
  });
  if (!membership?.organization) return null;
  const systemOrg = membership.organization.isSystemManaged;
  const adminUser = (systemOrg || context.adminScope === true) && (await isInstanceAdminUser(context.userId));
  if (systemOrg && !adminUser) return null;
  return {
    userId: context.userId,
    org: membership.organization,
    membership: { id: membership.id, role: membership.role, scopes: context.scopes },
    instanceAdmin: context.adminScope === true && adminUser,
  };
}
