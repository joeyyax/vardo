import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";
import { user } from "./auth";
import {
  appStatusEnum,
  cloneStrategyEnum,
  deployTypeEnum,
  deploymentStatusEnum,
  deploymentTriggerEnum,
  environmentTypeEnum,
  groupEnvironmentTypeEnum,
  sourceEnum,
  transferStatusEnum,
} from "./enums";
import { organizations } from "./organizations";
import { projects } from "./projects";
import { deployKeys } from "./config";

// ---------------------------------------------------------------------------
// Apps (deployable Docker units)
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
    dockerfilePath: text("dockerfile_path").default("Dockerfile"),
    rootDirectory: text("root_directory"),
    autoTraefikLabels: boolean("auto_traefik_labels").default(false),
    containerPort: integer("container_port"),
    autoDeploy: boolean("auto_deploy").default(false),
    // DEPRECATED: persistentVolumes JSONB replaced by the `volumes` table.
    // Column retained temporarily for migration; will be dropped once all data
    // has been migrated via `scripts/migrate-volumes.ts`.
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
    diskWriteAlertThreshold: bigint("disk_write_alert_threshold", { mode: "number" }), // bytes/hour, null = default 1GB
    autoRollback: boolean("auto_rollback").default(false), // Rollback on crash after deploy
    rollbackGracePeriod: integer("rollback_grace_period").default(60), // Seconds to monitor after deploy
    envContent: text("env_content"), // Encrypted env file blob (AES-256-GCM)
    // Compose decomposition: child service records point to parent compose app
    parentAppId: text("parent_app_id"),
    composeService: text("compose_service"), // service name from compose YAML
    containerName: text("container_name"), // computed: {projectName}-{serviceName}-1
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("app_org_name_uniq").on(t.organizationId, t.name),
    index("app_org_id_idx").on(t.organizationId),
    index("app_parent_app_id_idx").on(t.parentAppId),
  ]
);

// ---------------------------------------------------------------------------
// Deployments
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
  // Snapshot fields — captured on successful deploy for rollback
  envSnapshot: text("env_snapshot"), // Encrypted env blob at deploy time (AES-256-GCM)
  configSnapshot: jsonb("config_snapshot").$type<ConfigSnapshot>(),
  rollbackFromId: text("rollback_from_id"),
  // ID of the deployment that superseded this one (set when status = "superseded")
  supersededBy: text("superseded_by"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
},
  (t) => [
    index("deployment_app_id_idx").on(t.appId),
    index("deployment_app_started_at_idx").on(t.appId, t.startedAt),
  ]
);

// ---------------------------------------------------------------------------
// Environment Variables
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
// Domains
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
  redirectTo: text("redirect_to"),
  redirectCode: integer("redirect_code").default(301),
  createdAt: timestamp("created_at").defaultNow().notNull(),
},
  (t) => [
    index("domain_app_id_idx").on(t.appId),
  ]
);

// ---------------------------------------------------------------------------
// Group Environments (staging/preview environments spanning a group)
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
// Environments
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
// Tags (flat labels for filtering)
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
// Volumes (first-class volume records with integrated limits)
// ---------------------------------------------------------------------------

export const volumes = pgTable(
  "volume",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .references(() => apps.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // e.g. "data", "uploads"
    mountPath: text("mount_path").notNull(), // e.g. "/var/lib/postgresql/data"
    persistent: boolean("persistent").default(true).notNull(), // survives deploys
    shared: boolean("shared").default(false).notNull(), // can be mounted by other apps in project
    description: text("description"),
    maxSizeBytes: bigint("max_size_bytes", { mode: "number" }), // nullable = no limit
    warnAtPercent: integer("warn_at_percent").default(80),
    ignorePatterns: jsonb("ignore_patterns").$type<string[]>(), // glob patterns to ignore in diff (e.g. "uploads/**")
    driftCount: integer("drift_count").default(0), // unignored file drift after last deploy
    // Backup strategy: "tar" (default) for file volumes, "dump" for databases
    backupStrategy: text("backup_strategy").default("tar").notNull(),
    // For "dump" strategy: { dumpCmd, restoreCmd } — shell commands run via docker exec
    backupMeta: jsonb("backup_meta").$type<{ dumpCmd: string; restoreCmd: string }>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("volume_app_name_uniq").on(t.appId, t.name),
    unique("volume_app_mount_uniq").on(t.appId, t.mountPath),
    index("volume_app_id_idx").on(t.appId),
    index("volume_org_id_idx").on(t.organizationId),
    check("volume_dump_requires_meta", sql`backup_strategy != 'dump' OR backup_meta IS NOT NULL`),
  ]
);

// DEPRECATED: kept for migration only — will be dropped after migrate-volumes.ts runs
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
// Domain Checks (health monitoring history)
// ---------------------------------------------------------------------------

export const domainChecks = pgTable(
  "domain_check",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    reachable: boolean("reachable").notNull(),
    statusCode: integer("status_code"),
    responseTimeMs: integer("response_time_ms"),
    error: text("error"),
    checkedAt: timestamp("checked_at").defaultNow().notNull(),
  },
  (t) => [
    index("domain_check_domain_checked_at_idx").on(t.domainId, t.checkedAt),
  ]
);

// ---------------------------------------------------------------------------
// App Transfers (move apps between organizations)
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
