import { cache } from "react";
import { headers, cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { memberships, apiTokens, user } from "@/lib/db/schema";
import { findApiToken, type TokenScope } from "@/lib/auth/api-token";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { eq, and } from "drizzle-orm";

export const CURRENT_ORG_COOKIE = "host_current_org";

/** Auth method on a session result. Token auth carries its bound orgId. */
type TokenAuthMeta = {
  authMethod: "token";
  tokenOrgId: string;
  tokenId: string;
  tokenScope: TokenScope;
};
type SessionAuthMeta = { authMethod: "session" };
type AuthMeta = TokenAuthMeta | SessionAuthMeta;

type SessionResult = Awaited<ReturnType<typeof auth.api.getSession>> & AuthMeta;

/**
 * Current session from a Bearer token (when api-tokens is enabled), then the session cookie. Null if unauthenticated.
 * Token sessions never carry instance-admin power.
 */
export const getSession = cache(async (): Promise<SessionResult | null> => {
  const reqHeaders = await headers();

  const authHeader = reqHeaders.get("authorization");
  if (authHeader?.startsWith("Bearer ") && (await isFeatureEnabledAsync("api-tokens"))) {
    const rawToken = authHeader.slice(7).trim();
    if (rawToken) {
      const token = await findApiToken(rawToken);

      if (token) {
        const tokenUser = await db.query.user.findFirst({
          where: eq(user.id, token.userId),
        });

        if (tokenUser) {
          db.update(apiTokens)
            .set({ lastUsedAt: new Date() })
            .where(eq(apiTokens.id, token.id))
            .catch(() => {});

          return {
            user: {
              id: tokenUser.id,
              name: tokenUser.name,
              email: tokenUser.email,
              emailVerified: tokenUser.emailVerified,
              image: tokenUser.image,
              isAppAdmin: false,
              twoFactorEnabled: tokenUser.twoFactorEnabled,
            },
            session: {
              id: `token:${token.id}`,
              token: token.id,
              userId: tokenUser.id,
              expiresAt: token.expiresAt ?? new Date(Date.now() + 86400000),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            authMethod: "token",
            tokenOrgId: token.organizationId,
            tokenId: token.id,
            tokenScope: {
              crossOrg: token.crossOrg,
              expiresAt: token.expiresAt,
            },
          } as SessionResult;
        }
      }
    }
  }

  const sessionResult = await auth.api.getSession({
    headers: reqHeaders,
  });

  if (!sessionResult) return null;

  return {
    ...sessionResult,
    authMethod: "session",
  } as SessionResult;
});

/** Current org: the token's bound org, or the cookie preference then first membership. */
export const getCurrentOrg = cache(async () => {
  const session = await getSession();

  if (!session?.user?.id) {
    return null;
  }

  const isToken = session.authMethod === "token";

  const preferredOrgId = isToken
    ? session.tokenOrgId
    : (await cookies()).get(CURRENT_ORG_COOKIE)?.value;

  if (preferredOrgId) {
    const membership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.userId, session.user.id),
        eq(memberships.organizationId, preferredOrgId)
      ),
      with: {
        organization: true,
      },
    });

    const showSystemOrgs = await isFeatureEnabledAsync("selfManagement");
    if (membership && (showSystemOrgs || !membership.organization.isSystemManaged)) {
      return {
        organization: membership.organization,
        membership: {
          id: membership.id,
          role: membership.role,
        },
      };
    }
  }

  // A token is pinned to its org. Never fall back to another membership.
  if (isToken) return null;

  const showSystemOrgs = await isFeatureEnabledAsync("selfManagement");
  const allMemberships = await db.query.memberships.findMany({
    where: eq(memberships.userId, session.user.id),
    with: {
      organization: true,
    },
  });

  const membership = allMemberships.find(
    (m) => showSystemOrgs || !m.organization.isSystemManaged,
  ) ?? allMemberships[0];

  if (!membership) {
    return null;
  }

  return {
    organization: membership.organization,
    membership: {
      id: membership.id,
      role: membership.role,
    },
  };
});

/** Returns the session or throws if unauthenticated. */
export async function requireSession() {
  const session = await getSession();

  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  return session;
}

/** Returns session and org or throws. */
export async function requireOrg() {
  const session = await requireSession();
  const orgData = await getCurrentOrg();

  if (!orgData) {
    throw new Error("No organization found");
  }

  return {
    session,
    ...orgData,
  };
}

/** Organizations the current user belongs to. */
export const getUserOrganizations = cache(async () => {
  const session = await getSession();

  if (!session?.user?.id) {
    return [];
  }

  const userMemberships = await db.query.memberships.findMany({
    where: eq(memberships.userId, session.user.id),
    with: {
      organization: true,
    },
  });

  const showSystemOrgs = await isFeatureEnabledAsync("selfManagement");

  return userMemberships
    .filter((m) => showSystemOrgs || !m.organization.isSystemManaged)
    .map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.role,
    }));
});
