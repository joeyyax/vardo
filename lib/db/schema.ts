import {
  bigint,
  boolean,
  integer,
  pgEnum,
  pgTable,
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

export const projectStatusEnum = pgEnum("project_status", [
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
// Host: Organization Environment Variables (shared across projects)
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
// Host: Projects
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
    groupId: text("group_id").references(() => groups.id, {
      onDelete: "set null",
    }),
    cloneStrategy: cloneStrategyEnum("clone_strategy").default("clone"),
    dependsOn: jsonb("depends_on").$type<string[]>(),
    sortOrder: integer("sort_order").default(0),
    templateName: text("template_name"),
    templateVersion: text("template_version"),
    status: projectStatusEnum("status").notNull().default("stopped"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("project_org_name_uniq").on(t.organizationId, t.name)]
);

// ---------------------------------------------------------------------------
// Host: Deployments
// ---------------------------------------------------------------------------

export const deployments = pgTable("deployment", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
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
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(), // AES-256-GCM encrypted
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),
    isSecret: boolean("is_secret").default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("env_var_project_key_env_uniq").on(t.projectId, t.key, t.environmentId)]
);

// ---------------------------------------------------------------------------
// Host: Domains
// ---------------------------------------------------------------------------

export const domains = pgTable("domain", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
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
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: groupEnvironmentTypeEnum("type").notNull().default("staging"),
    sourceEnvironment: text("source_environment").default("production"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    createdBy: text("created_by").references(() => user.id),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("group_env_group_name_uniq").on(t.groupId, t.name)]
);

// ---------------------------------------------------------------------------
// Host: Environments
// ---------------------------------------------------------------------------

export const environments = pgTable(
  "environment",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: environmentTypeEnum("type").notNull().default("production"),
    domain: text("domain"),
    isDefault: boolean("is_default").default(false),
    clonedFromId: text("cloned_from_id"),
    groupEnvironmentId: text("group_environment_id").references(
      () => groupEnvironments.id,
      { onDelete: "cascade" }
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("env_project_name_uniq").on(t.projectId, t.name)]
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
  projectId: text("project_id").references(() => projects.id, {
    onDelete: "cascade",
  }),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Host: Groups (nestable project containers)
// ---------------------------------------------------------------------------

export const groups = pgTable(
  "group",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    color: text("color").notNull().default("#6366f1"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("group_org_name_uniq").on(t.organizationId, t.name)]
);

export const projectGroups = pgTable(
  "project_group",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (t) => [unique("project_group_uniq").on(t.projectId, t.groupId)]
);

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

export const projectTags = pgTable(
  "project_tag",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [unique("project_tag_uniq").on(t.projectId, t.tagId)]
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Many-to-many: which projects are included in a backup job
export const backupJobProjects = pgTable(
  "backup_job_project",
  {
    backupJobId: text("backup_job_id")
      .notNull()
      .references(() => backupJobs.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (t) => [unique("backup_job_project_uniq").on(t.backupJobId, t.projectId)]
);

// ---------------------------------------------------------------------------
// Host: Backup History (individual backup runs)
// ---------------------------------------------------------------------------

export const backups = pgTable("backup", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => backupJobs.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
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
// Host: Volume Limits (per-project storage constraints)
// ---------------------------------------------------------------------------

export const volumeLimits = pgTable("volume_limit", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" })
    .unique(),
  maxSizeBytes: bigint("max_size_bytes", { mode: "number" }).notNull(),
  warnAtPercent: integer("warn_at_percent").default(80),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
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
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  projects: many(projects),
  deployKeys: many(deployKeys),
  apiTokens: many(apiTokens),
  activities: many(activities),
  groups: many(groups),
  tags: many(tags),
  backupTargets: many(backupTargets),
  backupJobs: many(backupJobs),
  orgEnvVars: many(orgEnvVars),
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
  deployKey: one(deployKeys, {
    fields: [projects.gitKeyId],
    references: [deployKeys.id],
  }),
  group: one(groups, {
    fields: [projects.groupId],
    references: [groups.id],
  }),
  deployments: many(deployments),
  envVars: many(envVars),
  domains: many(domains),
  environments: many(environments),
  activities: many(activities),
  projectGroups: many(projectGroups),
  projectTags: many(projectTags),
  backupJobProjects: many(backupJobProjects),
  backups: many(backups),
  volumeLimit: many(volumeLimits),
}));

export const deploymentsRelations = relations(deployments, ({ one }) => ({
  project: one(projects, {
    fields: [deployments.projectId],
    references: [projects.id],
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
  project: one(projects, {
    fields: [envVars.projectId],
    references: [projects.id],
  }),
  environment: one(environments, {
    fields: [envVars.environmentId],
    references: [environments.id],
  }),
}));

export const domainsRelations = relations(domains, ({ one }) => ({
  project: one(projects, {
    fields: [domains.projectId],
    references: [projects.id],
  }),
}));

export const environmentsRelations = relations(
  environments,
  ({ one, many }) => ({
    project: one(projects, {
      fields: [environments.projectId],
      references: [projects.id],
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
  project: one(projects, {
    fields: [activities.projectId],
    references: [projects.id],
  }),
  user: one(user, {
    fields: [activities.userId],
    references: [user.id],
  }),
}));

export const groupsRelations = relations(groups, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [groups.organizationId],
    references: [organizations.id],
  }),
  parent: one(groups, {
    fields: [groups.parentId],
    references: [groups.id],
  }),
  projects: many(projects),
  projectGroups: many(projectGroups),
  groupEnvironments: many(groupEnvironments),
}));

export const groupEnvironmentsRelations = relations(
  groupEnvironments,
  ({ one, many }) => ({
    group: one(groups, {
      fields: [groupEnvironments.groupId],
      references: [groups.id],
    }),
    createdByUser: one(user, {
      fields: [groupEnvironments.createdBy],
      references: [user.id],
    }),
    environments: many(environments),
    deployments: many(deployments),
  })
);

export const projectGroupsRelations = relations(projectGroups, ({ one }) => ({
  project: one(projects, {
    fields: [projectGroups.projectId],
    references: [projects.id],
  }),
  group: one(groups, {
    fields: [projectGroups.groupId],
    references: [groups.id],
  }),
}));

export const tagsRelations = relations(tags, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [tags.organizationId],
    references: [organizations.id],
  }),
  projectTags: many(projectTags),
}));

export const projectTagsRelations = relations(projectTags, ({ one }) => ({
  project: one(projects, {
    fields: [projectTags.projectId],
    references: [projects.id],
  }),
  tag: one(tags, {
    fields: [projectTags.tagId],
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
  backupJobProjects: many(backupJobProjects),
  backups: many(backups),
}));

export const backupJobProjectsRelations = relations(
  backupJobProjects,
  ({ one }) => ({
    backupJob: one(backupJobs, {
      fields: [backupJobProjects.backupJobId],
      references: [backupJobs.id],
    }),
    project: one(projects, {
      fields: [backupJobProjects.projectId],
      references: [projects.id],
    }),
  })
);

export const backupsRelations = relations(backups, ({ one }) => ({
  job: one(backupJobs, {
    fields: [backups.jobId],
    references: [backupJobs.id],
  }),
  project: one(projects, {
    fields: [backups.projectId],
    references: [projects.id],
  }),
  target: one(backupTargets, {
    fields: [backups.targetId],
    references: [backupTargets.id],
  }),
}));

export const volumeLimitsRelations = relations(volumeLimits, ({ one }) => ({
  project: one(projects, {
    fields: [volumeLimits.projectId],
    references: [projects.id],
  }),
}));

export const orgEnvVarsRelations = relations(orgEnvVars, ({ one }) => ({
  organization: one(organizations, {
    fields: [orgEnvVars.organizationId],
    references: [organizations.id],
  }),
}));
