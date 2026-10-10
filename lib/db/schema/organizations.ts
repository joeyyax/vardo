import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { invitationScopeEnum, invitationStatusEnum, RESOURCE_PROFILES } from "./enums";

export const organizations = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  baseDomain: text("base_domain"),
  sslEnabled: boolean("ssl_enabled").default(true),
  trusted: boolean("trusted").default(false).notNull(),
  isSystemManaged: boolean("is_system_managed").default(false).notNull(),
  // Backups for apps that inherit. Null uses the system default.
  backupsEnabled: boolean("backups_enabled"),
  // HH:MM in the org's time zone the nightly backup run starts.
  nightlyBackupTime: text("nightly_backup_time").default("02:00").notNull(),
  // IANA zone for schedules and printed times. Null follows the instance.
  timeZone: text("time_zone"),
  // How far an app may stray from its baseline before it alerts.
  anomalySensitivity: text("anomaly_sensitivity", { enum: ["low", "normal", "high"] }).default("normal").notNull(),
  // Default resource profiles for apps that set none.
  memoryProfile: text("memory_profile", { enum: RESOURCE_PROFILES }).default("fixed").notNull(),
  cpuProfile: text("cpu_profile", { enum: RESOURCE_PROFILES }).default("fixed").notNull(),
  // Highest memory limit the auto profile may set, in MB. Null leaves only the host cap.
  memoryAutoMaxMb: integer("memory_auto_max_mb"),
  // Default for apps that leave "Post deploy status to GitHub" unset.
  githubFeedback: boolean("github_feedback").default(true).notNull(),
  // DNS TXT challenge for baseDomain.
  baseDomainToken: text("base_domain_token"),
  baseDomainVerifiedAt: timestamp("base_domain_verified_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const memberships = pgTable(
  "membership",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    // Anchor for the "while you were away" summary.
    lastSeenAt: timestamp("last_seen_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("membership_user_id_idx").on(t.userId),
    index("membership_org_id_idx").on(t.organizationId),
  ]
);

// Env vars shared across an org's apps.

export const orgEnvVars = pgTable(
  "org_env_var",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    description: text("description"),
    isSecret: boolean("is_secret").default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("org_env_var_org_key_uniq").on(t.organizationId, t.key)]
);

export const orgDomains = pgTable(
  "org_domain",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    isDefault: boolean("is_default").default(false),
    enabled: boolean("enabled").default(true).notNull(),
    verified: boolean("verified").default(false),
    verificationToken: text("verification_token"),
    verifiedAt: timestamp("verified_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("org_domain_uniq").on(t.organizationId, t.domain)]
);

export const invitations = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    scope: invitationScopeEnum("scope").notNull(),
    targetId: text("target_id"), // orgId for org scope, projectId for project scope, null for platform
    role: text("role").notNull(), // "owner", "admin", "member"
    status: invitationStatusEnum("status").notNull().default("pending"),
    tokenHash: text("token_hash").notNull().unique(), // SHA-256 of the token in the invite link
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("invitation_target_scope_status_idx").on(t.targetId, t.scope, t.status),
  ],
);
