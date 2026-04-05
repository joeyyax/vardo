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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  appStatusEnum,
  cloneStrategyEnum,
  deployTypeEnum,
  sourceEnum,
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
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    cloneStrategy: cloneStrategyEnum("clone_strategy").default("clone"),
    dependsOn: jsonb("depends_on").$type<string[]>(),
    sortOrder: integer("sort_order").default(0),
    templateName: text("template_name"),
    templateVersion: text("template_version"),
    status: appStatusEnum("status").notNull().default("stopped"),
    needsRedeploy: boolean("needs_redeploy").default(false),
    cpuLimit: real("cpu_limit"), // CPU cores (e.g. 0.5, 1, 2)
    memoryLimit: integer("memory_limit"), // Memory in MB (e.g. 256, 512, 1024)
    gpuEnabled: boolean("gpu_enabled").notNull().default(false), // GPU passthrough via deploy.resources.reservations.devices
    diskWriteAlertThreshold: bigint("disk_write_alert_threshold", { mode: "number" }), // bytes/hour, null = default 1GB
    healthCheckTimeout: integer("health_check_timeout"), // Seconds to wait for healthy containers (null = system default 60s)
    autoRollback: boolean("auto_rollback").default(false), // Rollback on crash after deploy
    rollbackGracePeriod: integer("rollback_grace_period").default(60), // Seconds to monitor after deploy
    isSystemManaged: boolean("is_system_managed").default(false).notNull(), // Managed by Vardo itself — deploy engine blocked
    backendProtocol: text("backend_protocol", { enum: ["http", "https"] }), // Backend scheme Traefik uses to reach the container. Null = auto (https if port 443/8443)
    envContent: text("env_content"), // Encrypted env file blob (AES-256-GCM)
    // Compose decomposition: child service records point to parent compose app
    parentAppId: text("parent_app_id"),
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
