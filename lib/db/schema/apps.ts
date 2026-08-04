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
    // Compose-safe key for this app's runtime resources — directory, compose
    // project, volumes, Traefik files. Set once and never rewritten, so renaming
    // an app does not move anything on disk. `id` cannot serve here: it is a
    // 21-char nanoid over a 64-symbol alphabet including uppercase, which
    // Compose rejects. Backfilled to `name` for apps that predate it.
    namespace: text("namespace"),
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
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    cloneStrategy: cloneStrategyEnum("clone_strategy").default("clone"),
    dependsOn: jsonb("depends_on").$type<string[]>(),
    sortOrder: integer("sort_order").default(0),
    templateName: text("template_name"),
    templateVersion: text("template_version"),
    status: appStatusEnum("status").notNull().default("stopped"),
    // When status last became what it is now. Written only by statusChange(),
    // never by an ordinary write — unlike updatedAt. Null until the first
    // transition, which reads as "how long is unknown".
    statusChangedAt: timestamp("status_changed_at"),
    // Declared off on purpose. Set and cleared only by setParked() — stopping an
    // app does not imply it, starting or deploying one clears it.
    parked: boolean("parked").notNull().default(false),
    // Container State.StartedAt, written by the status reconciler. Null when nothing is running.
    containerStartedAt: timestamp("container_started_at"),
    // Running container's cgroup memory limit in bytes. 0 means unlimited.
    containerMemoryLimit: bigint("container_memory_limit", { mode: "number" }),
    // Docker's RestartCount across this app's containers, written by the status
    // reconciler. Null means there was no counter to read — no container, or one
    // Docker would not answer for. Zero means it was read and is zero.
    containerRestartCount: integer("container_restart_count"),
    // Creation time of the oldest container the count covers — the point Docker
    // last reset it from. Null when there was no container to read.
    containerRestartSince: timestamp("container_restart_since"),
    // Last time the reconciler compared this app against Docker.
    statusCheckedAt: timestamp("status_checked_at"),
    // Last tick the reconciler observed this app running. Never cleared, so it
    // survives the container going away — unlike containerStartedAt.
    lastRunningAt: timestamp("last_running_at"),
    // Image reclamation for idle apps. "never" pins the app; "always" opts a
    // floating tag in, accepting that the next start pulls whatever it resolves to.
    imageReclaimPolicy: text("image_reclaim_policy", {
      enum: ["auto", "never", "always"],
    })
      .notNull()
      .default("auto"),
    // Days idle before this app's images may be reclaimed. Null uses the instance default.
    imageReclaimIdleDays: integer("image_reclaim_idle_days"),
    // How a running app is behaving, written by the health monitor. Separate
    // from status, which only records what Docker did with the container.
    conditions: jsonb("conditions").$type<AppCondition[]>(),
    // Why this app's containers stopped, written by the status reconciler and
    // cleared once anything is running again. Null while the app is up.
    exitReason: jsonb("exit_reason").$type<ExitReason>(),
    needsRedeploy: boolean("needs_redeploy").default(false),
    cpuLimit: real("cpu_limit"), // CPU cores (e.g. 0.5, 1, 2)
    memoryLimit: integer("memory_limit"), // Memory in MB (e.g. 256, 512, 1024)
    priority: appPriorityEnum("priority").default("standard"), // QoS tier → oom_score_adj, mem_reservation, cpu_shares in the Vardo overlay. Nullable: a decomposed child with null priority inherits its parent's tier; null on a non-child resolves to "standard".
    gpuEnabled: boolean("gpu_enabled").notNull().default(false), // GPU passthrough via deploy.resources.reservations.devices
    diskWriteAlertThreshold: bigint("disk_write_alert_threshold", { mode: "number" }), // bytes/hour, null = default 1GB
    healthCheckTimeout: integer("health_check_timeout"), // Seconds to wait for healthy containers (null = system default 60s)
    autoRollback: boolean("auto_rollback").default(false), // Rollback on crash after deploy
    rollbackGracePeriod: integer("rollback_grace_period").default(60), // Seconds to monitor after deploy
    autoRestartUnhealthy: boolean("auto_restart_unhealthy"), // Restart container when its healthcheck reports unhealthy. null = default (on for critical priority, off otherwise)
    isSystemManaged: boolean("is_system_managed").default(false).notNull(), // Managed by Vardo itself — deploy engine blocked
    backendProtocol: text("backend_protocol", { enum: ["http", "https"] }), // Backend scheme Traefik uses to reach the container. Null = auto (https if port 443/8443)
    envContent: text("env_content"), // Encrypted env file blob (AES-256-GCM)
    // Compose decomposition: child service records point to parent compose app.
    // Cascade — children die with the parent and are rebuilt from its compose
    // file on the next deploy. Never switch this to set null: that promotes
    // children into app_top_level_name_uniq's scope and the delete can fail on
    // an unrelated app's name.
    parentAppId: text("parent_app_id").references((): AnyPgColumn => apps.id, {
      onDelete: "cascade",
    }),
    composeService: text("compose_service"), // service name from compose YAML
    containerName: text("container_name"), // computed: {projectName}-{serviceName}-1
    importedContainerId: text("imported_container_id"), // original container ID when imported from Docker
    importedComposeProject: text("imported_compose_project"), // original compose project name when imported as a group
    configSource: text("config_source"), // "vardo.yml" when managed by config-as-code, null for UI-managed
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("app_org_name_uniq").on(t.organizationId, t.name),
    // A top-level app's name is its on-disk directory and compose project, so it
    // must be unique instance-wide. Do not scope this to the organization.
    uniqueIndex("app_top_level_name_uniq").on(t.name).where(sql`parent_app_id is null`),
    // Same scope as the name index above — a namespace is a compose project name,
    // which is global on the host.
    uniqueIndex("app_top_level_namespace_uniq")
      .on(t.namespace)
      .where(sql`parent_app_id is null and namespace is not null`),
    unique("app_imported_container_uniq").on(t.organizationId, t.importedContainerId),
    unique("app_imported_compose_project_uniq").on(t.organizationId, t.importedComposeProject),
    index("app_org_id_idx").on(t.organizationId),
    index("app_parent_app_id_idx").on(t.parentAppId),
    index("app_git_url_idx").on(t.gitUrl),
    uniqueIndex("app_system_managed_git_url_uniq").on(t.gitUrl).where(sql`is_system_managed = true`),
  ]
);

// Re-export split modules for backwards compatibility
export { deployments } from "./deployments";
export { envVars } from "./env-vars";
export { domains, domainChecks } from "./domains";
export { groupEnvironments, environments } from "./environments";
export { tags, appTags } from "./tags";
export { volumes, volumeLimits } from "./volumes";
export { appTransfers } from "./app-transfers";
