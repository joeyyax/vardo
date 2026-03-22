import { headers, cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

const CURRENT_ORG_COOKIE = "host_current_org";

/**
 * Get the current session on the server.
 * Returns null if not authenticated.
 */
export async function getSession() {
  return auth.api.getSession({
    headers: await headers(),
  });
}

/**
 * Get the current user's organization.
 * Checks for a stored org preference cookie first,
 * then falls back to the user's first organization.
 */
export async function getCurrentOrg() {
  const session = await getSession();

  if (!session?.user?.id) {
    return null;
  }

  // Check for org preference in cookie
  const cookieStore = await cookies();
  const preferredOrgId = cookieStore.get(CURRENT_ORG_COOKIE)?.value;

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
}

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
export async function getUserOrganizations() {
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
}
