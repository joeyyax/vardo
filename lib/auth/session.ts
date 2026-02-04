import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

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
 * Returns the first organization the user belongs to.
 * For now, we don't support org switching - we'll add that later.
 */
export async function getCurrentOrg() {
  const session = await getSession();

  if (!session?.user?.id) {
    return null;
  }

  // Find the user's first membership and its organization
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
