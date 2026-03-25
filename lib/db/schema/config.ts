import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organizations } from "./organizations";

// ---------------------------------------------------------------------------
// System Settings (key-value store for setup wizard + global config)
// ---------------------------------------------------------------------------

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// API Tokens
// ---------------------------------------------------------------------------

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
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("api_token_hash_idx").on(t.tokenHash),
    index("api_token_user_org_idx").on(t.userId, t.organizationId),
  ]
);

// ---------------------------------------------------------------------------
// Deploy Keys
// ---------------------------------------------------------------------------

export const deployKeys = pgTable("deploy_key", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(), // AES-256-GCM encrypted
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// GitHub App Installations
// ---------------------------------------------------------------------------

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
