import "server-only";

import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, type organizations } from "@/lib/db/schema";
import { getCurrentOrg, getSession } from "@/lib/auth/session";
import { isAppAdmin } from "@/lib/auth/admin";
import { isInstanceAdminUser } from "@/lib/auth/system-org";
import { can, type Capability } from "@/lib/auth/permissions";
import { isFeatureEnabledAsync, type FeatureFlag } from "@/lib/config/features";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { FeatureDisabledError, ForbiddenError } from "./errors";

export type Organization = typeof organizations.$inferSelect;

/** Who is asking, in which org, with what. Every service takes one. */
export type Actor = {
  userId: string;
  org: Organization;
  /** The role, narrowed by a token's scope when the caller is a token. */
  membership: { id?: string; role: string; scopes?: ReadonlySet<Capability> | null };
  /** Instance admin with a credential allowed to use it. */
  instanceAdmin: boolean;
};

/** The signed-in caller in their current org, or null without a session or org. */
export const currentActor = cache(async (): Promise<Actor | null> => {
  const [session, orgData] = await Promise.all([getSession(), getCurrentOrg()]);
  if (!session?.user?.id || !orgData) return null;
  return {
    userId: session.user.id,
    org: orgData.organization,
    membership: orgData.membership,
    instanceAdmin: await isAppAdmin(),
  };
});

/** The caller as an actor in `orgId`, or null when that isn't their current org. Throws like requireOrg without a session or org. */
export async function actorForOrg(orgId: string): Promise<Actor | null> {
  const session = await getSession();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const actor = await currentActor();
  if (!actor) throw new Error("No organization found");
  return actor.org.id === orgId ? actor : null;
}

/** An MCP token as an actor in `orgId`, or null when the token can't reach that org. */
export async function mcpActor(context: McpAuthContext, orgId: string): Promise<Actor | null> {
  if (!context.crossOrg && orgId !== context.organizationId) return null;
  const membership = await db.query.memberships.findFirst({
    where: and(eq(memberships.userId, context.userId), eq(memberships.organizationId, orgId)),
    columns: { id: true, role: true },
    with: { organization: true },
  });
  if (!membership?.organization) return null;
  const instanceAdmin = await isInstanceAdminUser(context.userId);
  if (membership.organization.isSystemManaged && !instanceAdmin) return null;
  return {
    userId: context.userId,
    org: membership.organization,
    membership: { id: membership.id, role: membership.role, scopes: context.scopes },
    instanceAdmin: context.adminScope === true && instanceAdmin,
  };
}

/** Whether the actor holds `cap` in their org. */
export function allows(actor: Actor, cap: Capability): boolean {
  return can(actor.membership, cap, { instanceAdmin: actor.instanceAdmin });
}

/** Throws ForbiddenError unless the actor holds `cap`. */
export function authorize(actor: Actor, cap: Capability): void {
  if (!allows(actor, cap)) throw new ForbiddenError(cap);
}

/** Throws FeatureDisabledError when `flag` is off. */
export async function requireFeature(flag: FeatureFlag): Promise<void> {
  if (!(await isFeatureEnabledAsync(flag))) throw new FeatureDisabledError(flag);
}
