// ---------------------------------------------------------------------------
// Role constants — single source of truth for org-level roles
// ---------------------------------------------------------------------------

export const ROLES = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
} as const;

export type OrgRole = (typeof ROLES)[keyof typeof ROLES];

/** Proposed read-only role. In the capability map only; not assignable yet. */
export const VIEWER = "viewer";

export type Role = OrgRole | typeof VIEWER;

// ---------------------------------------------------------------------------
// Capabilities — what each role may do in an org
// ---------------------------------------------------------------------------

const OWNER_ONLY: readonly Role[] = [ROLES.OWNER];
const ADMINS: readonly Role[] = [ROLES.OWNER, ROLES.ADMIN];
const MEMBERS: readonly Role[] = [ROLES.OWNER, ROLES.ADMIN, ROLES.MEMBER];
const EVERYONE: readonly Role[] = [ROLES.OWNER, ROLES.ADMIN, ROLES.MEMBER, VIEWER];

export const CAPABILITIES = {
  // Org
  "org.view": EVERYONE,
  "org.settings": ADMINS,
  "org.delete": OWNER_ONLY,
  "org.ownership.transfer": OWNER_ONLY,
  "org.members.manage": ADMINS,
  "org.digest.manage": ADMINS,
  "org.notifications.manage": MEMBERS,
  "org.tokens.manage": MEMBERS,
  "org.deployKeys.manage": MEMBERS,
  "org.domains.manage": MEMBERS,
  "org.tags.manage": MEMBERS,
  "org.transfers.manage": ADMINS,

  // Projects and apps
  "project.manage": MEMBERS,
  "app.view": EVERYONE,
  "app.create": MEMBERS,
  // Instance admin is also required.
  "app.import": MEMBERS,
  "app.config": MEMBERS,
  "app.gpu": ADMINS,
  "app.domains": MEMBERS,
  "app.deploy": MEMBERS,
  "app.terminal": MEMBERS,
  "app.cron": ADMINS,
  "app.debug": ADMINS,
  "app.delete": ADMINS,
  "app.volumes.sync": MEMBERS,

  // Env vars
  "env.read": MEMBERS,
  "env.write": MEMBERS,

  // Backups
  "backup.view": MEMBERS,
  "backup.run": MEMBERS,
  "backup.restore": ADMINS,
  "backup.download": ADMINS,
  "backup.delete": ADMINS,
  "backup.targets.manage": ADMINS,
  "backup.jobs.manage": ADMINS,
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

/** True when `role` holds `cap`. Unknown or missing roles hold nothing. */
export function can(role: string | null | undefined, cap: Capability): boolean {
  if (!role) return false;
  return (CAPABILITIES[cap] as readonly string[]).includes(role);
}

/** Every capability `role` holds, for passing to client components. */
export function capabilitiesFor(role: string | null | undefined): Capability[] {
  return (Object.keys(CAPABILITIES) as Capability[]).filter((cap) => can(role, cap));
}

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
