// ---------------------------------------------------------------------------
// Infrastructure auto-provisioning
//
// Deploys optional infrastructure services (cAdvisor, Loki, Promtail) as
// managed apps when their feature flags are enabled. Services are created
// from built-in templates and attached to a system-managed project.
//
// Called at startup (instrumentation.ts) and on feature flag toggle.
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db } from "@/lib/db";
import { apps, environments, projects } from "@/lib/db/schema";
import { isFeatureEnabledAsync, type FeatureFlag } from "@/lib/config/features";
import { loadTemplates, type Template } from "@/lib/templates/load";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { ensureVardoOrg } from "@/lib/infra/vardo-org";
import { logger } from "@/lib/logger";

const log = logger.child("infra");

/**
 * Feature-to-template mapping. Each entry defines which feature flag
 * controls which templates should be provisioned.
 */
const INFRA_FEATURES: {
  flag: FeatureFlag;
  templates: string[];
  project: { name: string; displayName: string };
  /** Override per-template app settings (e.g. enable Traefik labels for user-facing services). */
  appOverrides?: Partial<{ autoTraefikLabels: boolean }>;
}[] = [
  { flag: "metrics", templates: ["cadvisor"], project: { name: "metrics", displayName: "Metrics" } },
  { flag: "logging", templates: ["loki", "promtail"], project: { name: "logs", displayName: "Logs" } },
  { flag: "error-tracking", templates: ["glitchtip"], project: { name: "error-tracking", displayName: "Error Tracking" }, appOverrides: { autoTraefikLabels: true } },
];

/**
 * Ensure all infrastructure services are provisioned based on feature flags.
 * Safe to call on every startup — all writes are idempotent.
 */
export async function ensureInfraServices(): Promise<void> {
  const org = await ensureVardoOrg();
  if (!org) {
    log.info("No admin user yet, skipping infra provisioning");
    return;
  }

  const templates = await loadTemplates();

  for (const { flag, templates: templateNames, project: projDef, appOverrides } of INFRA_FEATURES) {
    const enabled = await isFeatureEnabledAsync(flag);
    if (!enabled) continue;

    const project = await ensureProject(org.id, projDef.name, projDef.displayName);

    for (const name of templateNames) {
      const template = templates.find((t) => t.name === name);
      if (!template) {
        log.warn(`Template "${name}" not found, skipping`);
        continue;
      }

      try {
        await ensureAppDeployed(org.id, project.id, template, appOverrides);
      } catch (err) {
        log.error(`Failed to provision ${name}:`, err);
      }
    }
  }
}

/**
 * Provision or deprovision specific templates based on a feature flag change.
 * Called from the feature flags API route after a toggle.
 */
export async function provisionForFlag(flag: FeatureFlag, enabled: boolean): Promise<void> {
  if (!enabled) return; // Containers keep running when feature is disabled

  const mapping = INFRA_FEATURES.find((f) => f.flag === flag);
  if (!mapping) return;

  const org = await ensureVardoOrg();
  if (!org) return;

  const project = await ensureProject(org.id, mapping.project.name, mapping.project.displayName);
  const templates = await loadTemplates();

  for (const name of mapping.templates) {
    const template = templates.find((t) => t.name === name);
    if (!template) continue;

    try {
      await ensureAppDeployed(org.id, project.id, template, mapping.appOverrides);
    } catch (err) {
      log.error(`Failed to provision ${name}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function ensureProject(orgId: string, name: string, displayName: string) {
  const [project] = await db
    .insert(projects)
    .values({
      id: nanoid(),
      organizationId: orgId,
      name,
      displayName,
      isSystemManaged: true,
      allowBindMounts: true,
    })
    .onConflictDoUpdate({
      target: [projects.organizationId, projects.name],
      set: {
        displayName,
        isSystemManaged: true,
        allowBindMounts: true,
        updatedAt: new Date(),
      },
    })
    .returning({ id: projects.id });

  return project;
}

async function ensureAppDeployed(orgId: string, projectId: string, template: Template, overrides?: Partial<{ autoTraefikLabels: boolean }>) {
  // Check if app already exists
  const existing = await db.query.apps.findFirst({
    where: and(
      eq(apps.organizationId, orgId),
      eq(apps.name, template.name),
      eq(apps.isSystemManaged, true),
    ),
    columns: { id: true },
  });

  if (existing) {
    // For cadvisor: ensure gpuEnabled matches host GPU availability
    if (template.name === "cadvisor") {
      const hasGpu = await detectNvidiaGpu();
      await db.update(apps).set({ gpuEnabled: hasGpu }).where(eq(apps.id, existing.id));
      if (hasGpu) log.info(`cAdvisor: GPU detected, enabled GPU metrics`);
    }
    log.info(`Infra app "${template.name}" already exists`);
    return;
  }

  // Create the app from the template. Wrapped in try/catch for the unique
  // constraint — concurrent calls (startup + flag toggle) could both pass the
  // findFirst check above.
  const appId = nanoid();

  // For cadvisor: detect GPU to enable NVML-based metrics
  const gpuEnabled = template.name === "cadvisor" ? await detectNvidiaGpu() : false;

  try {
    await db.insert(apps).values({
      id: appId,
      organizationId: orgId,
      projectId,
      name: template.name,
      displayName: template.displayName,
      description: template.description,
      source: template.source as "git" | "direct",
      deployType: template.deployType as "compose",
      composeContent: template.composeContent,
      containerPort: template.defaultPort,
      isSystemManaged: true,
      cpuLimit: template.defaultCpuLimit,
      memoryLimit: template.defaultMemoryLimit,
      diskWriteAlertThreshold: template.defaultDiskWriteAlertThreshold,
      autoTraefikLabels: overrides?.autoTraefikLabels ?? false,
      gpuEnabled,
    });
  } catch (err) {
    // Unique constraint violation — another call already created it
    if (err instanceof Error && err.message.includes("unique")) {
      log.info(`Infra app "${template.name}" already created by concurrent call`);
      return;
    }
    throw err;
  }

  // Create production environment
  await db.insert(environments).values({
    id: nanoid(),
    appId,
    name: "production",
    type: "production",
    isDefault: true,
  });

  log.info(`Created infra app "${template.name}", triggering deploy`);

  // Deploy the app — fire-and-forget so startup isn't blocked
  requestDeploy({
    appId,
    organizationId: orgId,
    trigger: "api",
  }).catch((err) => {
    log.error(`Deploy failed for infra app "${template.name}":`, err);
  });
}

/** Check if an NVIDIA GPU runtime is available on the Docker host. */
async function detectNvidiaGpu(): Promise<boolean> {
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("docker", ["info", "--format", "{{json .Runtimes}}"], { timeout: 5000 });
    return stdout.includes("nvidia");
  } catch {
    return false;
  }
}
