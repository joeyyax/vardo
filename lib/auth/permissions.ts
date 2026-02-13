import { db } from "@/lib/db";
import { projectMembers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Check if a role has admin-level access (owner or admin).
 */
export function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Require admin role, throw if not.
 */
export function requireAdmin(role: string): void {
  if (!isAdminRole(role)) {
    throw new Error("Forbidden");
  }
}

/**
 * Get the project IDs a member has been assigned to.
 * Returns null for admin/owner (meaning "all projects").
 */
export async function getAccessibleProjectIds(
  userId: string,
  role: string
): Promise<string[] | null> {
  if (isAdminRole(role)) return null; // no filtering needed

  const assignments = await db.query.projectMembers.findMany({
    where: eq(projectMembers.userId, userId),
    columns: { projectId: true },
  });

  return assignments.map((a) => a.projectId);
}
