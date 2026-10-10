import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  appPriorityEnum,
  appStatusEnum,
  cloneStrategyEnum,
  deployTypeEnum,
  sourceEnum,
} from "./enums";
import { organizations } from "./organizations";
import { projects } from "./projects";
import { deployKeys } from "./config";
import type { AppCondition } from "@/lib/docker/conditions";
import type { ExitReason } from "@/lib/docker/exit-reason";

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
    // Buildpack overrides. Null lets Railpack or Nixpacks decide.
    buildCommand: text("build_command"),
    startCommand: text("start_command"),
    buildProvider: text("build_provider", { enum: ["railpack", "nixpacks"] }),
    autoTraefikLabels: boolean("auto_traefik_labels").default(false),
    containerPort: integer("container_port"),
    autoDeploy: boolean("auto_deploy").default(false),
    /** @deprecated Replaced by the `volumes` table. */
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
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    cloneStrategy: cloneStrategyEnum("clone_strategy").default("clone"),
    dependsOn: jsonb("depends_on").$type<string[]>(),
    sortOrder: integer("sort_order").default(0),
    templateName: text("template_name"),
    templateVersion: text("template_version"),
    status: appStatusEnum("status").notNull().default("stopped"),
    // When status last changed. Written only by statusChange(). Null until the first transition.
    statusChangedAt: timestamp("status_changed_at"),
    // An operator stopped this app. Set and cleared only by setParked().
    parked: boolean("parked").notNull().default(false),
    // Container State.StartedAt, written by the status reconciler. Null when nothing is running.
    containerStartedAt: timestamp("container_started_at"),
    // Running container's cgroup memory limit in bytes. 0 means unlimited.
    containerMemoryLimit: bigint("container_memory_limit", { mode: "number" }),
    // Docker's RestartCount across this app's containers. Null means there was no counter to read.
    containerRestartCount: integer("container_restart_count"),
    // Creation time of the oldest container the count covers.
    containerRestartSince: timestamp("container_restart_since"),
    // Last time the reconciler compared this app against Docker.
    statusCheckedAt: timestamp("status_checked_at"),
    // Last tick the reconciler saw this app running. Never cleared.
    lastRunningAt: timestamp("last_running_at"),
    // Image reclamation for idle apps. "never" pins the app; "always" includes floating tags.
    imageReclaimPolicy: text("image_reclaim_policy", {
      enum: ["auto", "never", "always"],
    })
      .notNull()
      .default("auto"),
    // Days idle before this app's images may be reclaimed. Null uses the instance default.
    imageReclaimIdleDays: integer("image_reclaim_idle_days"),
    // How a running app is behaving, written by the health monitor.
    conditions: jsonb("conditions").$type<AppCondition[]>(),
    // Why this app's containers stopped. Null while the app is up.
    exitReason: jsonb("exit_reason").$type<ExitReason>(),
    needsRedeploy: boolean("needs_redeploy").default(false),
    cpuLimit: real("cpu_limit"), // CPU cores (e.g. 0.5, 1, 2)
    memoryLimit: integer("memory_limit"), // Memory in MB (e.g. 256, 512, 1024)
    priority: appPriorityEnum("priority").default("standard"), // QoS tier. Null on a child inherits the parent's tier.
    gpuEnabled: boolean("gpu_enabled").notNull().default(false),
    // Services that get this app's own TLS certificates read-only at /certs. Null is off.
    certServices: jsonb("cert_services").$type<string[]>(),
    backupsEnabled: boolean("backups_enabled"), // null = inherit the org's, then the system's default
    diskWriteAlertThreshold: bigint("disk_write_alert_threshold", { mode: "number" }), // bytes/hour, null = default 1GB
    // Alerts when the app strays from its own learned baseline.
    anomalyAlerts: boolean("anomaly_alerts").notNull().default(true),
    healthCheckTimeout: integer("health_check_timeout"), // Seconds; null = system default 60s
    autoRollback: boolean("auto_rollback").default(false),
    rollbackGracePeriod: integer("rollback_grace_period").default(60), // Seconds to monitor after deploy
    autoRestartUnhealthy: boolean("auto_restart_unhealthy"), // null = on for critical priority, off otherwise
    isSystemManaged: boolean("is_system_managed").default(false).notNull(), // Deploy engine blocked
    backendProtocol: text("backend_protocol", { enum: ["http", "https"] }), // Null = auto (https on 443/8443)
    // Default security headers on the app's HTTPS routers.
    securityHeaders: boolean("security_headers").notNull().default(true),
    envContent: text("env_content"), // Encrypted
    // Compose child to parent. Must cascade: set null moves children into app_top_level_name_uniq's scope.
    parentAppId: text("parent_app_id").references((): AnyPgColumn => apps.id, {
      onDelete: "cascade",
    }),
    composeService: text("compose_service"), // service name from compose YAML
    containerName: text("container_name"), // {projectName}-{serviceName}-1
    importedContainerId: text("imported_container_id"),
    importedComposeProject: text("imported_compose_project"),
    configSource: text("config_source"), // "vardo.yml" when managed by config-as-code
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("app_org_name_uniq").on(t.organizationId, t.name),
    // Top-level names are directories and compose projects: unique instance-wide, never per org.
    uniqueIndex("app_top_level_name_uniq").on(t.name).where(sql`parent_app_id is null`),
    unique("app_imported_container_uniq").on(t.organizationId, t.importedContainerId),
    unique("app_imported_compose_project_uniq").on(t.organizationId, t.importedComposeProject),
    index("app_org_id_idx").on(t.organizationId),
    index("app_parent_app_id_idx").on(t.parentAppId),
    index("app_git_url_idx").on(t.gitUrl),
    uniqueIndex("app_system_managed_git_url_uniq").on(t.gitUrl).where(sql`is_system_managed = true`),
  ]
);

export { deployments } from "./deployments";
export { envVars } from "./env-vars";
export { domains, domainChecks } from "./domains";
export { groupEnvironments, environments, environmentEnv } from "./environments";
export { tags, appTags } from "./tags";
export { volumes, volumeLimits } from "./volumes";
export { appTransfers } from "./app-transfers";
