import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  jsonb,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const sourceTypeEnum = pgEnum("source_type", [
  "git",
  "image",
  "compose",
]);

export const serviceStatusEnum = pgEnum("service_status", [
  "active",
  "stopped",
  "error",
  "deploying",
]);

export const deploymentStatusEnum = pgEnum("deployment_status", [
  "queued",
  "running",
  "success",
  "failed",
  "cancelled",
]);

export const deploymentTriggerEnum = pgEnum("deployment_trigger", [
  "manual",
  "webhook",
  "api",
  "rollback",
]);

// ---------------------------------------------------------------------------
// Better Auth tables (kept as-is)
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull(),
  image: text("image"),
  isAppAdmin: boolean("isAppAdmin").default(false),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: text("expiresAt").notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  activeOrganizationId: text("activeOrganizationId"),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  accessTokenExpiresAt: text("accessTokenExpiresAt"),
  refreshTokenExpiresAt: text("refreshTokenExpiresAt"),
  scope: text("scope"),
  idToken: text("idToken"),
  password: text("password"),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: text("expiresAt").notNull(),
  createdAt: text("createdAt"),
  updatedAt: text("updatedAt"),
});

// ---------------------------------------------------------------------------
// Organizations (simplified from Scope)
// ---------------------------------------------------------------------------

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const memberships = pgTable("memberships", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: text("createdAt").notNull(),
});

// ---------------------------------------------------------------------------
// Host: Deploy Keys
// ---------------------------------------------------------------------------

export const deployKeys = pgTable("deploy_keys", {
  id: text("id").primaryKey(),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  publicKey: text("publicKey").notNull(),
  privateKey: text("privateKey").notNull(), // AES-256-GCM encrypted
  createdAt: text("createdAt").notNull(),
});

// ---------------------------------------------------------------------------
// Host: Services
// ---------------------------------------------------------------------------

export const services = pgTable(
  "services",
  {
    id: text("id").primaryKey(),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    displayName: text("displayName").notNull(),
    description: text("description"),
    sourceType: sourceTypeEnum("sourceType").notNull(),
    gitUrl: text("gitUrl"),
    gitBranch: text("gitBranch").default("main"),
    gitKeyId: text("gitKeyId").references(() => deployKeys.id, {
      onDelete: "set null",
    }),
    imageName: text("imageName"),
    composeContent: text("composeContent"),
    composeFilePath: text("composeFilePath").default("docker-compose.yml"),
    autoTraefikLabels: boolean("autoTraefikLabels").default(false),
    containerPort: integer("containerPort"),
    autoDeploy: boolean("autoDeploy").default(false),
    status: serviceStatusEnum("status").notNull().default("stopped"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [unique("services_org_name_uniq").on(t.organizationId, t.name)]
);

// ---------------------------------------------------------------------------
// Host: Deployments
// ---------------------------------------------------------------------------

export const deployments = pgTable("deployments", {
  id: text("id").primaryKey(),
  serviceId: text("serviceId")
    .notNull()
    .references(() => services.id, { onDelete: "cascade" }),
  status: deploymentStatusEnum("status").notNull().default("queued"),
  trigger: deploymentTriggerEnum("trigger").notNull(),
  gitSha: text("gitSha"),
  log: text("log"),
  durationMs: integer("durationMs"),
  triggeredBy: text("triggeredBy").references(() => user.id, {
    onDelete: "set null",
  }),
  startedAt: text("startedAt").notNull(),
  finishedAt: text("finishedAt"),
});

// ---------------------------------------------------------------------------
// Host: Environment Variables
// ---------------------------------------------------------------------------

export const envVars = pgTable(
  "env_vars",
  {
    id: text("id").primaryKey(),
    serviceId: text("serviceId")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(), // AES-256-GCM encrypted
    isSecret: boolean("isSecret").default(true),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (t) => [unique("env_vars_service_key_uniq").on(t.serviceId, t.key)]
);

// ---------------------------------------------------------------------------
// Host: Domains
// ---------------------------------------------------------------------------

export const domains = pgTable("domains", {
  id: text("id").primaryKey(),
  serviceId: text("serviceId")
    .notNull()
    .references(() => services.id, { onDelete: "cascade" }),
  domain: text("domain").notNull().unique(),
  serviceName: text("serviceName"), // compose service name for multi-service
  port: integer("port"),
  middlewares: text("middlewares"), // comma-separated: 'tailscale-only@docker'
  certResolver: text("certResolver").default("le"),
  createdAt: text("createdAt").notNull(),
});

// ---------------------------------------------------------------------------
// Host: API Tokens
// ---------------------------------------------------------------------------

export const apiTokens = pgTable("api_tokens", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("tokenHash").notNull(), // bcrypt hash, never plaintext
  lastUsedAt: text("lastUsedAt"),
  createdAt: text("createdAt").notNull(),
});

// ---------------------------------------------------------------------------
// Host: Activities (audit trail)
// ---------------------------------------------------------------------------

export const activities = pgTable("activities", {
  id: text("id").primaryKey(),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  serviceId: text("serviceId").references(() => services.id, {
    onDelete: "cascade",
  }),
  userId: text("userId").references(() => user.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  metadata: jsonb("metadata"),
  createdAt: text("createdAt").notNull(),
});
