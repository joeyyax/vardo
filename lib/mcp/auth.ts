import { db } from "@/lib/db";
import { apiTokens, user } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { findApiToken } from "@/lib/auth/api-token";
import { tokenScopeCapabilities, type Capability } from "@/lib/auth/permissions";

export type McpAuthContext = {
  userId: string;
  /** The organization the token was minted for. */
  organizationId: string;
  /** Opt-in widening to every organization the token's user belongs to. */
  crossOrg: boolean;
  /** The token's scope; null or absent allows everything the role does. */
  scopes?: ReadonlySet<Capability> | null;
  /** The token's opt-in instance-admin scope; canAdminInstance also checks the live admin flag. */
  adminScope?: boolean;
  /** The token's opt-in scope for running tools on linked instances. */
  linkedInstances?: boolean;
  /** Set when a linked instance forwarded this call. */
  via?: { peerId: string; instanceId: string; name: string };
};

/** Authenticates a raw MCP Request by Bearer token. Null if invalid or api-tokens is off. */
export async function authenticateRequest(
  request: Request
): Promise<McpAuthContext | null> {
  if (!(await isFeatureEnabledAsync("api-tokens"))) return null;

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const rawToken = authHeader.slice(7).trim();
  if (!rawToken) return null;

  const token = await findApiToken(rawToken);

  if (!token) return null;

  const tokenUser = await db.query.user.findFirst({
    where: eq(user.id, token.userId),
    columns: { id: true },
  });

  if (!tokenUser) return null;

  // Fire and forget.
  db.update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, token.id))
    .catch(() => {});

  return {
    userId: token.userId,
    organizationId: token.organizationId,
    crossOrg: token.crossOrg,
    scopes: tokenScopeCapabilities(token.scope, token.capabilities),
    adminScope: token.adminAccess === true,
    linkedInstances: token.linkedInstances === true,
  };
}
