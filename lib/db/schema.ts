import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const sourceEnum = pgEnum("source", ["git", "direct"]);

export const deployTypeEnum = pgEnum("deploy_type", [
  "compose",
  "dockerfile",
  "image",
  "static",
  "nixpacks",
]);

export const appStatusEnum = pgEnum("app_status", [
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

export const environmentTypeEnum = pgEnum("environment_type", [
  "production",
  "staging",
  "preview",
]);

export const cloneStrategyEnum = pgEnum("clone_strategy", [
  "clone",
  "clone_data",
  "empty",
  "skip",
]);

export const groupEnvironmentTypeEnum = pgEnum("group_environment_type", [
  "staging",
  "preview",
]);

export const transferStatusEnum = pgEnum("transfer_status", [
  "pending",
  "accepted",
  "rejected",
  "cancelled",
]);

export const notificationChannelTypeEnum = pgEnum("notification_channel_type", [
  "email",
  "webhook",
  "slack",
]);

// ---------------------------------------------------------------------------
// Better Auth tables (snake_case columns, matching Scope's working schema)
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  isAppAdmin: boolean("is_app_admin").default(false),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const passkey = pgTable("passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  credentialID: text("credential_id").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text("transports"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const twoFactor = pgTable("two_factor", {
  id: text("id").primaryKey(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const memberships = pgTable("membership", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Host: Organization Environment Variables (shared across apps)
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
// Host: Organization Domains (additive domain list)
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
// Host: Deploy Keys
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
// Host: GitHub App Installations
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

// ---------------------------------------------------------------------------
// Host: Projects (groups of related apps)
// ---------------------------------------------------------------------------

export const projects = pgTable(
  "project",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    color: text("color").default("#6366f1"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("project_org_name_uniq").on(t.organizationId, t.name)]
);

// ---------------------------------------------------------------------------
// Host: Apps (deployable Docker units)
// ---------------------------------------------------------------------------

export const apps = pgTable(
  "app",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    source: sourceEnum("source").notNull().default("git"),
    deployType: deployTypeEnum("deploy_type").notNull().default("compose"),
    gitUrl: text("git_url"),
    gitBranch: text("git_branch").default("main"),
    gitKeyId: text("git_key_id").references(() => deployKeys.id, {
      onDelete: "set null",
    }),
    imageName: text("image_name"),
    composeContent: text("compose_content"),
    composeFilePath: text("compose_file_path").default("docker-compose.yml"),
    rootDirectory: text("root_directory"),
    autoTraefikLabels: boolean("auto_traefik_labels").default(false),
    containerPort: integer("container_port"),
    autoDeploy: boolean("auto_deploy").default(false),
    persistentVolumes: jsonb("persistent_volumes").$type<
      { name: string; mountPath: string }[]
    >(),
    exposedPorts: jsonb("exposed_ports").$type<
      { internal: number; external?: number; protocol?: string; description?: string }[]
    >(),
    restartPolicy: text("restart_policy").default("unless-stopped"),
    connectionInfo: jsonb("connection_info").$type<
      { label: string; value: string; copyRef?: string }[]
    >(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    cloneStrategy: cloneStrategyEnum("clone_strategy").default("clone"),
    dependsOn: jsonb("depends_on").$type<string[]>(),
    sortOrder: integer("sort_order").default(0),
    templateName: text("template_name"),
    templateVersion: text("template_version"),
    status: appStatusEnum("status").notNull().default("stopped"),
    needsRedeploy: boolean("needs_redeploy").default(false),
    cpuLimit: real("cpu_limit"), // CPU cores (e.g. 0.5, 1, 2)
    memoryLimit: integer("memory_limit"), // Memory in MB (e.g. 256, 512, 1024)
    envContent: text("env_content"), // Encrypted env file blob (AES-256-GCM)
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("app_org_name_uniq").on(t.organizationId, t.name),
  ]
);

// ---------------------------------------------------------------------------
// Host: Deployments
// ---------------------------------------------------------------------------

export const deployments = pgTable("deployment", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  status: deploymentStatusEnum("status").notNull().default("queued"),
  trigger: deploymentTriggerEnum("trigger").notNull(),
  gitSha: text("git_sha"),
  gitMessage: text("git_message"),
  log: text("log"),
  durationMs: integer("duration_ms"),
  environmentId: text("environment_id").references(() => environments.id, {
    onDelete: "set null",
  }),
  groupEnvironmentId: text("group_environment_id").references(
    () => groupEnvironments.id,
    { onDelete: "set null" }
  ),
  triggeredBy: text("triggered_by").references(() => user.id, {
    onDelete: "set null",
  }),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
});

// ---------------------------------------------------------------------------
// Host: Environment Variables
// ---------------------------------------------------------------------------

export const envVars = pgTable(
  "env_var",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(), // AES-256-GCM encrypted
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),
    isSecret: boolean("is_secret").default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("env_var_app_key_env_uniq").on(t.appId, t.key, t.environmentId)]
);

// ---------------------------------------------------------------------------
// Host: Domains
// ---------------------------------------------------------------------------

export const domains = pgTable("domain", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  domain: text("domain").notNull().unique(),
  serviceName: text("service_name"),
  port: integer("port"),
  middlewares: text("middlewares"),
  certResolver: text("cert_resolver").default("le"),
  isPrimary: boolean("is_primary").default(false),
  sslEnabled: boolean("ssl_enabled").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Host: Group Environments (staging/preview environments spanning a group)
// ---------------------------------------------------------------------------

export const groupEnvironments = pgTable(
  "group_environment",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: groupEnvironmentTypeEnum("type").notNull().default("staging"),
    sourceEnvironment: text("source_environment").default("production"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    createdBy: text("created_by").references(() => user.id),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("group_env_project_name_uniq").on(t.projectId, t.name)]
);

// ---------------------------------------------------------------------------
// Host: Environments
// ---------------------------------------------------------------------------

export const environments = pgTable(
  "environment",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: environmentTypeEnum("type").notNull().default("production"),
    domain: text("domain"),
    gitBranch: text("git_branch"),
    isDefault: boolean("is_default").default(false),
    clonedFromId: text("cloned_from_id"),
    groupEnvironmentId: text("group_environment_id").references(
      () => groupEnvironments.id,
      { onDelete: "cascade" }
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("env_app_name_uniq").on(t.appId, t.name)]
);

// ---------------------------------------------------------------------------
// Host: API Tokens
// ---------------------------------------------------------------------------

export const apiTokens = pgTable("api_token", {
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
});

// ---------------------------------------------------------------------------
// Host: Activities (audit trail)
// ---------------------------------------------------------------------------

export const activities = pgTable("activity", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  appId: text("app_id").references(() => apps.id, {
    onDelete: "set null",
  }),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Host: Tags (flat labels for filtering)
// ---------------------------------------------------------------------------

export const tags = pgTable(
  "tag",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#6366f1"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("tag_org_name_uniq").on(t.organizationId, t.name)]
);

export const appTags = pgTable(
  "app_tag",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [unique("app_tag_uniq").on(t.appId, t.tagId)]
);

// ---------------------------------------------------------------------------
// Host: Backup Targets (where backups are stored)
// ---------------------------------------------------------------------------

export const backupTargetTypeEnum = pgEnum("backup_target_type", [
  "s3",
  "r2",
  "b2",
  "ssh",
]);

export const backupTargets = pgTable("backup_target", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").references(() => organizations.id, {
    onDelete: "cascade",
  }),
  name: text("name").notNull(),
  type: backupTargetTypeEnum("type").notNull(),
  config: jsonb("config")
    .notNull()
    .$type<
      | {
          bucket: string;
          region: string;
          endpoint?: string;
          accessKeyId: string;
          secretAccessKey: string;
          prefix?: string;
        }
      | {
          host: string;
          port?: number;
          username: string;
          privateKey?: string;
          path: string;
        }
    >(),
  isDefault: boolean("is_default").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Host: Backup Jobs (scheduled backup configurations)
// ---------------------------------------------------------------------------

export const backupStatusEnum = pgEnum("backup_status", [
  "pending",
  "running",
  "success",
  "failed",
  "pruned",
]);

export const backupJobs = pgTable("backup_job", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  targetId: text("target_id")
    .notNull()
    .references(() => backupTargets.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  schedule: text("schedule").notNull().default("0 2 * * *"),
  enabled: boolean("enabled").default(true).notNull(),
  // Proxmox-style retention
  keepAll: boolean("keep_all").default(false),
  keepLast: integer("keep_last"),
  keepHourly: integer("keep_hourly"),
  keepDaily: integer("keep_daily"),
  keepWeekly: integer("keep_weekly"),
  keepMonthly: integer("keep_monthly"),
  keepYearly: integer("keep_yearly"),
  // Notification settings
  notifyOnSuccess: boolean("notify_on_success").default(false),
  notifyOnFailure: boolean("notify_on_failure").default(true),
  lastRunAt: timestamp("last_run_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Many-to-many: which apps are included in a backup job
export const backupJobApps = pgTable(
  "backup_job_app",
  {
    backupJobId: text("backup_job_id")
      .notNull()
      .references(() => backupJobs.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
  },
  (t) => [unique("backup_job_app_uniq").on(t.backupJobId, t.appId)]
);

// ---------------------------------------------------------------------------
// Host: Backup History (individual backup runs)
// ---------------------------------------------------------------------------

export const backups = pgTable("backup", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => backupJobs.id, { onDelete: "cascade" }),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  targetId: text("target_id")
    .notNull()
    .references(() => backupTargets.id, { onDelete: "cascade" }),
  status: backupStatusEnum("status").notNull().default("pending"),
  volumeName: text("volume_name"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  storagePath: text("storage_path"),
  log: text("log"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
});

// ---------------------------------------------------------------------------
// Host: Volume Limits (per-app storage constraints)
// ---------------------------------------------------------------------------

export const volumeLimits = pgTable("volume_limit", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" })
    .unique(),
  maxSizeBytes: bigint("max_size_bytes", { mode: "number" }).notNull(),
  warnAtPercent: integer("warn_at_percent").default(80),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Host: Domain Checks (health monitoring history)
// ---------------------------------------------------------------------------

export const domainChecks = pgTable("domain_check", {
  id: text("id").primaryKey(),
  domainId: text("domain_id")
    .notNull()
    .references(() => domains.id, { onDelete: "cascade" }),
  reachable: boolean("reachable").notNull(),
  statusCode: integer("status_code"),
  responseTimeMs: integer("response_time_ms"),
  error: text("error"),
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Host: Templates
// ---------------------------------------------------------------------------

export const templateCategoryEnum = pgEnum("template_category", [
  "database",
  "cache",
  "monitoring",
  "web",
  "tool",
  "custom",
]);

export const templates = pgTable("template", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  icon: text("icon"),
  category: templateCategoryEnum("category").notNull().default("custom"),
  source: sourceEnum("source").notNull().default("direct"),
  deployType: deployTypeEnum("deploy_type").notNull().default("image"),
  imageName: text("image_name"),
  gitUrl: text("git_url"),
  gitBranch: text("git_branch"),
  composeContent: text("compose_content"),
  rootDirectory: text("root_directory"),
  defaultPort: integer("default_port"),
  defaultEnvVars: jsonb("default_env_vars").$type<
    { key: string; description: string; required: boolean; defaultValue?: string }[]
  >(),
  defaultVolumes: jsonb("default_volumes").$type<
    { name: string; mountPath: string; description: string }[]
  >(),
  defaultConnectionInfo: jsonb("default_connection_info").$type<
    { label: string; value: string; copyRef?: string }[]
  >(),
  isBuiltIn: boolean("is_built_in").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Host: Cron Jobs (scheduled tasks)
// ---------------------------------------------------------------------------

export const cronJobTypeEnum = pgEnum("cron_job_type", [
  "command",
  "url",
]);

export const cronJobStatusEnum = pgEnum("cron_job_status", [
  "success",
  "failed",
  "running",
]);

export const cronJobs = pgTable("cron_job", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: cronJobTypeEnum("type").notNull().default("command"),
  schedule: text("schedule").notNull(), // cron expression
  command: text("command").notNull(), // shell command or URL depending on type
  enabled: boolean("enabled").default(true).notNull(),
  lastRunAt: timestamp("last_run_at"),
  lastStatus: cronJobStatusEnum("last_status"),
  lastLog: text("last_log"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Host: Cron Job Runs (execution history)
// ---------------------------------------------------------------------------

export const cronJobRunStatusEnum = pgEnum("cron_job_run_status", [
  "success",
  "failed",
]);

export const cronJobRuns = pgTable(
  "cron_job_run",
  {
    id: text("id").primaryKey(),
    cronJobId: text("cron_job_id")
      .notNull()
      .references(() => cronJobs.id, { onDelete: "cascade" }),
    status: cronJobRunStatusEnum("status").notNull(),
    startedAt: timestamp("started_at").notNull(),
    completedAt: timestamp("completed_at"),
    output: text("output"),
    error: text("error"),
  },
  (t) => [index("cron_job_run_job_id_idx").on(t.cronJobId)]
);

// ---------------------------------------------------------------------------
// Host: App Transfers (move apps between organizations)
// ---------------------------------------------------------------------------

export const appTransfers = pgTable("app_transfer", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  sourceOrgId: text("source_org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  destinationOrgId: text("destination_org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  status: transferStatusEnum("status").notNull().default("pending"),
  initiatedBy: text("initiated_by")
    .references(() => user.id, { onDelete: "set null" }),
  respondedBy: text("responded_by")
    .references(() => user.id, { onDelete: "set null" }),
  frozenRefs: jsonb("frozen_refs").$type<
    { key: string; originalRef: string; frozenValue: string }[]
  >(),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  respondedAt: timestamp("responded_at"),
});

// ---------------------------------------------------------------------------
// Host: Notification Channels
// ---------------------------------------------------------------------------

export const notificationChannels = pgTable(
  "notification_channel",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: notificationChannelTypeEnum("type").notNull(),
    config: jsonb("config").notNull().$type<{ recipients: string[] } | { url: string; secret?: string } | { webhookUrl: string }>(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("notification_channel_org_idx").on(t.organizationId)]
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  memberships: many(memberships),
  deployments: many(deployments),
  apiTokens: many(apiTokens),
  activities: many(activities),
  githubAppInstallations: many(githubAppInstallations),
  initiatedTransfers: many(appTransfers, { relationName: "initiatedByUser" }),
  respondedTransfers: many(appTransfers, { relationName: "respondedByUser" }),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  projects: many(projects),
  apps: many(apps),
  deployKeys: many(deployKeys),
  apiTokens: many(apiTokens),
  activities: many(activities),
  tags: many(tags),
  backupTargets: many(backupTargets),
  backupJobs: many(backupJobs),
  orgEnvVars: many(orgEnvVars),
  orgDomains: many(orgDomains),
  outgoingTransfers: many(appTransfers, { relationName: "sourceOrg" }),
  incomingTransfers: many(appTransfers, { relationName: "destinationOrg" }),
  notificationChannels: many(notificationChannels),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(user, {
    fields: [memberships.userId],
    references: [user.id],
  }),
  organization: one(organizations, {
    fields: [memberships.organizationId],
    references: [organizations.id],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.organizationId],
    references: [organizations.id],
  }),
  apps: many(apps),
  groupEnvironments: many(groupEnvironments),
}));

export const appsRelations = relations(apps, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [apps.organizationId],
    references: [organizations.id],
  }),
  deployKey: one(deployKeys, {
    fields: [apps.gitKeyId],
    references: [deployKeys.id],
  }),
  project: one(projects, {
    fields: [apps.projectId],
    references: [projects.id],
  }),
  deployments: many(deployments),
  envVars: many(envVars),
  domains: many(domains),
  environments: many(environments),
  activities: many(activities),
  appTags: many(appTags),
  backupJobApps: many(backupJobApps),
  backups: many(backups),
  volumeLimit: many(volumeLimits),
  cronJobs: many(cronJobs),
  transfers: many(appTransfers),
}));

export const deploymentsRelations = relations(deployments, ({ one }) => ({
  app: one(apps, {
    fields: [deployments.appId],
    references: [apps.id],
  }),
  environment: one(environments, {
    fields: [deployments.environmentId],
    references: [environments.id],
  }),
  groupEnvironment: one(groupEnvironments, {
    fields: [deployments.groupEnvironmentId],
    references: [groupEnvironments.id],
  }),
  triggeredByUser: one(user, {
    fields: [deployments.triggeredBy],
    references: [user.id],
  }),
}));

export const envVarsRelations = relations(envVars, ({ one }) => ({
  app: one(apps, {
    fields: [envVars.appId],
    references: [apps.id],
  }),
  environment: one(environments, {
    fields: [envVars.environmentId],
    references: [environments.id],
  }),
}));

export const domainsRelations = relations(domains, ({ one, many }) => ({
  app: one(apps, {
    fields: [domains.appId],
    references: [apps.id],
  }),
  domainChecks: many(domainChecks),
}));

export const domainChecksRelations = relations(domainChecks, ({ one }) => ({
  domain: one(domains, {
    fields: [domainChecks.domainId],
    references: [domains.id],
  }),
}));

export const environmentsRelations = relations(
  environments,
  ({ one, many }) => ({
    app: one(apps, {
      fields: [environments.appId],
      references: [apps.id],
    }),
    groupEnvironment: one(groupEnvironments, {
      fields: [environments.groupEnvironmentId],
      references: [groupEnvironments.id],
    }),
    envVars: many(envVars),
    deployments: many(deployments),
  })
);

export const deployKeysRelations = relations(deployKeys, ({ one }) => ({
  organization: one(organizations, {
    fields: [deployKeys.organizationId],
    references: [organizations.id],
  }),
}));

export const githubAppInstallationsRelations = relations(
  githubAppInstallations,
  ({ one }) => ({
    user: one(user, {
      fields: [githubAppInstallations.userId],
      references: [user.id],
    }),
  })
);

export const apiTokensRelations = relations(apiTokens, ({ one }) => ({
  user: one(user, {
    fields: [apiTokens.userId],
    references: [user.id],
  }),
  organization: one(organizations, {
    fields: [apiTokens.organizationId],
    references: [organizations.id],
  }),
}));

export const activitiesRelations = relations(activities, ({ one }) => ({
  organization: one(organizations, {
    fields: [activities.organizationId],
    references: [organizations.id],
  }),
  app: one(apps, {
    fields: [activities.appId],
    references: [apps.id],
  }),
  user: one(user, {
    fields: [activities.userId],
    references: [user.id],
  }),
}));

export const groupEnvironmentsRelations = relations(
  groupEnvironments,
  ({ one, many }) => ({
    project: one(projects, {
      fields: [groupEnvironments.projectId],
      references: [projects.id],
    }),
    createdByUser: one(user, {
      fields: [groupEnvironments.createdBy],
      references: [user.id],
    }),
    environments: many(environments),
    deployments: many(deployments),
  })
);

export const tagsRelations = relations(tags, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [tags.organizationId],
    references: [organizations.id],
  }),
  appTags: many(appTags),
}));

export const appTagsRelations = relations(appTags, ({ one }) => ({
  app: one(apps, {
    fields: [appTags.appId],
    references: [apps.id],
  }),
  tag: one(tags, {
    fields: [appTags.tagId],
    references: [tags.id],
  }),
}));

export const backupTargetsRelations = relations(
  backupTargets,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [backupTargets.organizationId],
      references: [organizations.id],
    }),
    backupJobs: many(backupJobs),
    backups: many(backups),
  })
);

export const backupJobsRelations = relations(backupJobs, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [backupJobs.organizationId],
    references: [organizations.id],
  }),
  target: one(backupTargets, {
    fields: [backupJobs.targetId],
    references: [backupTargets.id],
  }),
  backupJobApps: many(backupJobApps),
  backups: many(backups),
}));

export const backupJobAppsRelations = relations(
  backupJobApps,
  ({ one }) => ({
    backupJob: one(backupJobs, {
      fields: [backupJobApps.backupJobId],
      references: [backupJobs.id],
    }),
    app: one(apps, {
      fields: [backupJobApps.appId],
      references: [apps.id],
    }),
  })
);

export const backupsRelations = relations(backups, ({ one }) => ({
  job: one(backupJobs, {
    fields: [backups.jobId],
    references: [backupJobs.id],
  }),
  app: one(apps, {
    fields: [backups.appId],
    references: [apps.id],
  }),
  target: one(backupTargets, {
    fields: [backups.targetId],
    references: [backupTargets.id],
  }),
}));

export const volumeLimitsRelations = relations(volumeLimits, ({ one }) => ({
  app: one(apps, {
    fields: [volumeLimits.appId],
    references: [apps.id],
  }),
}));

export const cronJobsRelations = relations(cronJobs, ({ one, many }) => ({
  app: one(apps, {
    fields: [cronJobs.appId],
    references: [apps.id],
  }),
  runs: many(cronJobRuns),
}));

export const cronJobRunsRelations = relations(cronJobRuns, ({ one }) => ({
  cronJob: one(cronJobs, {
    fields: [cronJobRuns.cronJobId],
    references: [cronJobs.id],
  }),
}));

export const orgEnvVarsRelations = relations(orgEnvVars, ({ one }) => ({
  organization: one(organizations, {
    fields: [orgEnvVars.organizationId],
    references: [organizations.id],
  }),
}));

export const orgDomainsRelations = relations(orgDomains, ({ one }) => ({
  organization: one(organizations, {
    fields: [orgDomains.organizationId],
    references: [organizations.id],
  }),
}));

export const appTransfersRelations = relations(
  appTransfers,
  ({ one }) => ({
    app: one(apps, {
      fields: [appTransfers.appId],
      references: [apps.id],
    }),
    sourceOrg: one(organizations, {
      fields: [appTransfers.sourceOrgId],
      references: [organizations.id],
      relationName: "sourceOrg",
    }),
    destinationOrg: one(organizations, {
      fields: [appTransfers.destinationOrgId],
      references: [organizations.id],
      relationName: "destinationOrg",
    }),
    initiatedByUser: one(user, {
      fields: [appTransfers.initiatedBy],
      references: [user.id],
      relationName: "initiatedByUser",
    }),
    respondedByUser: one(user, {
      fields: [appTransfers.respondedBy],
      references: [user.id],
      relationName: "respondedByUser",
    }),
  })
);

export const notificationChannelsRelations = relations(notificationChannels, ({ one }) => ({ organization: one(organizations, { fields: [notificationChannels.organizationId], references: [organizations.id] }) }));
