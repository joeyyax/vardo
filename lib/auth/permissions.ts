/**
 * Throws "Forbidden" if the role doesn't have admin-level access.
 * Owner and admin roles are considered admin-level.
 */
export function requireAdmin(role: string) {
  if (role !== "owner" && role !== "admin") {
    throw new Error("Forbidden");
  }
}

export function isAdmin(role: string) {
  return role === "owner" || role === "admin";
}
