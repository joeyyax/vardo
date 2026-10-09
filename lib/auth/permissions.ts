// Org-level roles.

export const ROLES = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
} as const;

export type OrgRole = (typeof ROLES)[keyof typeof ROLES];

/** Proposed read-only role. In the capability map only; not assignable yet. */
export const VIEWER = "viewer";

export type Role = OrgRole | typeof VIEWER;

// What each role may do in an org.

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
  // Mesh peers are instance-wide.
  "mesh.peers.view": ADMINS,

  // Projects and apps
  "project.manage": MEMBERS,
  "project.delete": ADMINS,
  "app.view": EVERYONE,
  "app.create": MEMBERS,
  // Instance admin is also required.
  "app.import": MEMBERS,
  "app.config": MEMBERS,
  "app.gpu": ADMINS,
  // Hands the app's own TLS private keys to its containers.
  "app.certs": ADMINS,
  "app.domains": MEMBERS,
  "app.deploy": MEMBERS,
  // Root shell; host root through an enabled Docker socket.
  "app.terminal": ADMINS,
  // Create or change a job that runs `sh -c` in the container.
  "app.cron.command": ADMINS,
  "app.cron": MEMBERS,
  "app.debug": ADMINS,
  "app.delete": ADMINS,
  "app.volumes.sync": ADMINS,

  // Env vars
  // Masked values.
  "env.read": MEMBERS,
  // Plaintext secrets.
  "env.reveal": ADMINS,
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

/** Backup capabilities an instance admin holds in any org they belong to. */
export const INSTANCE_ADMIN_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "backup.view",
  "backup.run",
  "backup.restore",
  "backup.download",
  "backup.delete",
  "backup.targets.manage",
  "backup.jobs.manage",
]);

// API token scopes. A token holds the intersection of its scope and the user's live role.

export const TOKEN_PRESETS = ["full", "deploy", "read"] as const;
export type TokenPreset = (typeof TOKEN_PRESETS)[number];
/** Stored on the token: a preset, or "custom" for an explicit capability list. */
export type TokenScopeKind = TokenPreset | "custom";

const ALL_CAPABILITIES = Object.keys(CAPABILITIES) as Capability[];

export function isCapability(value: string): value is Capability {
  return Object.hasOwn(CAPABILITIES, value);
}

const READ_ONLY: ReadonlySet<Capability> = new Set<Capability>([
  ...ALL_CAPABILITIES.filter((cap) => cap.endsWith(".view")),
  "env.read",
]);

const PRESET_CAPABILITIES: Record<Exclude<TokenPreset, "full">, ReadonlySet<Capability>> = {
  read: READ_ONLY,
  deploy: new Set<Capability>([...READ_ONLY, "app.deploy"]),
};

/** Capabilities a token's scope allows, or null when it allows everything the role does. An unknown kind allows nothing. */
export function tokenScopeCapabilities(
  kind: string | null | undefined,
  capabilities: readonly string[] | null | undefined,
): ReadonlySet<Capability> | null {
  if (kind == null || kind === "full") return null;
  if (kind === "read" || kind === "deploy") return PRESET_CAPABILITIES[kind];
  if (kind === "custom") return new Set((capabilities ?? []).filter(isCapability));
  return new Set();
}

/** A role, or a membership that may carry a token's scope. */
export type Subject =
  | string
  | null
  | undefined
  | { role: string | null | undefined; scopes?: ReadonlySet<Capability> | null };

type Grant = { instanceAdmin?: boolean };

/** Whether `subject` holds `cap`. Pass the membership, not its role, or a token scope is skipped. */
export function can(subject: Subject, cap: Capability, grant: Grant = {}): boolean {
  const role = typeof subject === "object" && subject !== null ? subject.role : subject;
  const scopes = typeof subject === "object" && subject !== null ? subject.scopes : null;
  if (!role) return false;
  if (scopes && !scopes.has(cap)) return false;
  if (grant.instanceAdmin && INSTANCE_ADMIN_CAPABILITIES.has(cap)) return true;
  return (CAPABILITIES[cap] as readonly string[]).includes(role);
}

/** Every capability `subject` holds, for passing to client components. */
export function capabilitiesFor(subject: Subject, grant: Grant = {}): Capability[] {
  return ALL_CAPABILITIES.filter((cap) => can(subject, cap, grant));
}
