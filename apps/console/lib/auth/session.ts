import { cache } from "react";
import { headers, cookies } from "next/headers";
import { createHash } from "crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { memberships, apiTokens, user } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export const CURRENT_ORG_COOKIE = "host_current_org";

/**
 * Get the current session on the server.
 *
 * Resolution order:
 *  1. `Authorization: Bearer <token>` header — resolves to the token owner's session
 *  2. Session cookie via Better Auth
 *
 * Returns null if not authenticated.
 */
export const getSession = cache(async () => {
  const reqHeaders = await headers();

  // Check for Bearer token first (API token auth)
  const authHeader = reqHeaders.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const rawToken = authHeader.slice(7).trim();
    if (rawToken) {
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");
      const token = await db.query.apiTokens.findFirst({
        where: eq(apiTokens.tokenHash, tokenHash),
        columns: { id: true, userId: true, organizationId: true },
      });

      if (token) {
        const tokenUser = await db.query.user.findFirst({
          where: eq(user.id, token.userId),
        });

        if (tokenUser) {
          // Update lastUsedAt in the background
          db.update(apiTokens)
            .set({ lastUsedAt: new Date() })
            .where(eq(apiTokens.id, token.id))
            .catch(() => {});

          // Return a session-like object compatible with Better Auth's shape
          return {
            user: {
              id: tokenUser.id,
              name: tokenUser.name,
              email: tokenUser.email,
              emailVerified: tokenUser.emailVerified,
              image: tokenUser.image,
              isAppAdmin: tokenUser.isAppAdmin,
              twoFactorEnabled: tokenUser.twoFactorEnabled,
            },
            session: {
              id: `token:${token.id}`,
              token: token.id,
              userId: tokenUser.id,
              expiresAt: new Date(Date.now() + 86400000),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            // Stash the token's org for getCurrentOrg to use
            _tokenOrgId: token.organizationId,
          };
        }
      }
    }
  }

  // Fall back to session cookie
  return auth.api.getSession({
    headers: reqHeaders,
  });
});

/**
 * Get the current user's organization.
 * Checks for a stored org preference cookie first,
 * then falls back to the user's first organization.
 */
export const getCurrentOrg = cache(async () => {
  const session = await getSession();

  if (!session?.user?.id) {
    return null;
  }

  // If authenticated via API token, use the token's bound org
  const tokenOrgId = (session as Record<string, unknown>)?._tokenOrgId as string | undefined;

  // Check for org preference: token org > cookie > first membership
  const cookieStore = await cookies();
  const preferredOrgId = tokenOrgId || cookieStore.get(CURRENT_ORG_COOKIE)?.value;

  // If there's a preferred org, verify user has access to it
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

    if (membership) {
      return {
        organization: membership.organization,
        membership: {
          id: membership.id,
          role: membership.role,
        },
      };
    }
  }

  // Fall back to first membership
  const membership = await db.query.memberships.findFirst({
    where: eq(memberships.userId, session.user.id),
    with: {
      organization: true,
    },
  });

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

/**
 * Require a session - throws if not authenticated.
 * Use this in API routes where auth is required.
 */
export async function requireSession() {
  const session = await getSession();

  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  return session;
}

/**
 * Require an organization - throws if not authenticated or no org.
 * Use this in API routes that need org context.
 */
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

/**
 * Get all organizations the current user has access to.
 * Returns an empty array if not authenticated.
 */
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

  return userMemberships.map((m) => ({
    id: m.organization.id,
    name: m.organization.name,
    slug: m.organization.slug,
    role: m.role,
  }));
});
