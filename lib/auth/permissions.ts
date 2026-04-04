// ---------------------------------------------------------------------------
// Role constants — single source of truth for org-level roles
// ---------------------------------------------------------------------------

export const ROLES = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
} as const;

export type OrgRole = (typeof ROLES)[keyof typeof ROLES];

const ADMIN_ROLES: ReadonlySet<string> = new Set([ROLES.OWNER, ROLES.ADMIN]);

/**
 * Throws "Forbidden" if the role doesn't have admin-level access.
 * Owner and admin roles are considered admin-level.
 */
export function requireOrgAdmin(role: string) {
  if (!ADMIN_ROLES.has(role)) {
    throw new Error("Forbidden");
  }
}

export function isOrgAdmin(role: string) {
  return ADMIN_ROLES.has(role);
}
