import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { invitationScopeEnum, invitationStatusEnum } from "./enums";

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export const organizations = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  baseDomain: text("base_domain"),
  sslEnabled: boolean("ssl_enabled").default(true),
  trusted: boolean("trusted").default(false).notNull(),
  isSystemManaged: boolean("is_system_managed").default(false).notNull(),
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("membership_user_id_idx").on(t.userId),
    index("membership_org_id_idx").on(t.organizationId),
  ]
);

// ---------------------------------------------------------------------------
// Organization Environment Variables (shared across apps)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Organization Domains (additive domain list)
// ---------------------------------------------------------------------------

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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("org_domain_uniq").on(t.organizationId, t.domain)]
);

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export const invitations = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    scope: invitationScopeEnum("scope").notNull(),
    targetId: text("target_id"), // orgId for org scope, projectId for project scope, null for platform
    role: text("role").notNull(), // "owner", "admin", "member"
    status: invitationStatusEnum("status").notNull().default("pending"),
    token: text("token").notNull().unique(),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("invitation_target_scope_status_idx").on(t.targetId, t.scope, t.status),
  ],
);
