// ---------------------------------------------------------------------------
// Infrastructure auto-provisioning
//
// Deploys optional infrastructure services (cAdvisor, Loki, Promtail) as
// managed apps when their feature flags are enabled. Services are created
// from built-in templates and attached to a system-managed project.
//
// Called at startup (instrumentation.ts) and on feature flag toggle.
// ---------------------------------------------------------------------------

import { asc, and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db } from "@/lib/db";
import { apps, environments, organizations, projects } from "@/lib/db/schema";
import { isFeatureEnabledAsync, type FeatureFlag } from "@/lib/config/features";
import { loadTemplates, type Template } from "@/lib/templates/load";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { stopContainer } from "@/lib/docker/client";
import { logger } from "@/lib/logger";

const log = logger.child("infra");

/**
 * Feature-to-template mapping. Each entry defines which feature flag
 * controls which templates should be provisioned.
 */
const INFRA_FEATURES: { flag: FeatureFlag; templates: string[] }[] = [
  { flag: "metrics", templates: ["cadvisor"] },
  { flag: "logging", templates: ["loki", "promtail"] },
];

/**
 * Ensure all infrastructure services are provisioned based on feature flags.
 * Safe to call on every startup — all writes are idempotent.
 */
export async function ensureInfraServices(): Promise<void> {
  const org = await getFirstOrg();
  if (!org) {
    log.info("No organization found, skipping infra provisioning");
    return;
  }

  const project = await ensureInfraProject(org.id);
  const templates = await loadTemplates();

  for (const { flag, templates: templateNames } of INFRA_FEATURES) {
    const enabled = await isFeatureEnabledAsync(flag);

    for (const name of templateNames) {
      const template = templates.find((t) => t.name === name);
      if (!template) {
        log.warn(`Template "${name}" not found, skipping`);
        continue;
      }

      try {
        if (enabled) {
          await ensureAppDeployed(org.id, project.id, template);
        } else {
          await ensureAppStopped(org.id, name);
        }
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
  const mapping = INFRA_FEATURES.find((f) => f.flag === flag);
  if (!mapping) return;

  const org = await getFirstOrg();
  if (!org) return;

  const project = await ensureInfraProject(org.id);
  const templates = await loadTemplates();

  for (const name of mapping.templates) {
    const template = templates.find((t) => t.name === name);
    if (!template) continue;

    try {
      if (enabled) {
        await ensureAppDeployed(org.id, project.id, template);
      } else {
        await ensureAppStopped(org.id, name);
      }
    } catch (err) {
      log.error(`Failed to ${enabled ? "provision" : "stop"} ${name}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function getFirstOrg() {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(asc(organizations.createdAt))
    .limit(1);
  return org ?? null;
}

async function ensureInfraProject(orgId: string) {
  const [project] = await db
    .insert(projects)
    .values({
      id: nanoid(),
      organizationId: orgId,
      name: "vardo-infra",
      displayName: "Infrastructure",
      isSystemManaged: true,
      allowBindMounts: true,
    })
    .onConflictDoUpdate({
      target: [projects.organizationId, projects.name],
      set: {
        displayName: "Infrastructure",
        isSystemManaged: true,
        allowBindMounts: true,
        updatedAt: new Date(),
      },
    })
    .returning({ id: projects.id });

  return project;
}

async function ensureAppDeployed(orgId: string, projectId: string, template: Template) {
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
    log.info(`Infra app "${template.name}" already exists, skipping`);
    return;
  }

  // Create the app from the template
  const appId = nanoid();

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
    autoTraefikLabels: false,
  });

  // Create production environment
  await db.insert(environments).values({
    id: nanoid(),
    appId,
    name: "production",
    type: "production",
    isDefault: true,
  });

  log.info(`Created infra app "${template.name}", triggering deploy`);

  // Deploy the app
  await requestDeploy({
    appId,
    organizationId: orgId,
    trigger: "api",
  });
}

async function ensureAppStopped(orgId: string, name: string) {
  const app = await db.query.apps.findFirst({
    where: and(
      eq(apps.organizationId, orgId),
      eq(apps.name, name),
      eq(apps.isSystemManaged, true),
    ),
    columns: { id: true },
  });

  if (!app) return;

  // Stop the container by its pinned name
  const containerName = `vardo-${name}`;
  try {
    await stopContainer(containerName);
    log.info(`Stopped infra container "${containerName}"`);
  } catch {
    // Container may not be running
    log.info(`Infra container "${containerName}" not running`);
  }
}
