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
import { organizations } from "./organizations";
import type { TokenScopeKind } from "@/lib/auth/permissions";

// Key-value store for setup and global config.

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const apiTokens = pgTable(
  "api_token",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    // Lets the token act on any of its user's organizations. Keep the default false; flipping it widens every token.
    crossOrg: boolean("cross_org").default(false).notNull(),
    // "full", "deploy", "read" or "custom"; intersected with the user's live role.
    scope: text("scope").$type<TokenScopeKind>().default("full").notNull(),
    // Only read when scope is "custom".
    capabilities: text("capabilities").array(),
    // Unused: tokens never carry instance-admin power.
    adminAccess: boolean("admin_access").default(false).notNull(),
    // Null never expires.
    expiresAt: timestamp("expires_at"),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("api_token_hash_idx").on(t.tokenHash),
    index("api_token_user_org_idx").on(t.userId, t.organizationId),
  ]
);

export const deployKeys = pgTable("deploy_key", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(), // Encrypted
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const githubAppInstallations = pgTable(
  "github_app_installation",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(), // "User" or "Organization"
    accountAvatarUrl: text("account_avatar_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("gh_install_user_uniq").on(t.userId, t.installationId),
  ]
);

/** Installations an org may clone with and take push webhooks from. */
export const githubInstallationOrgs = pgTable(
  "github_installation_org",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull(),
    linkedByUserId: text("linked_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("gh_install_org_uniq").on(t.organizationId, t.installationId),
    index("gh_install_org_installation_idx").on(t.installationId),
  ]
);
