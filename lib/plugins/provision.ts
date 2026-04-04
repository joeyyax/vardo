// ---------------------------------------------------------------------------
// Plugin service auto-provisioning
//
// Deploys a backing service (e.g. cadvisor, glitchtip, uptime-kuma) for a
// plugin by loading the matching template and creating an app + deploy.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { apps, environments, volumes, domains, organizations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { loadTemplates } from "@/lib/templates/load";
import { generateSubdomain } from "@/lib/domains/auto-domain";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { stopProject } from "@/lib/docker/deploy";
import { setPluginSetting, getPluginSetting, deletePluginSetting } from "./registry";
import { logger } from "@/lib/logger";
import type { ServiceRequirement } from "./manifest";

const log = logger.child("plugin-provision");

/**
 * Provision a backing service for a plugin.
 *
 * Loads the matching template, creates an app record with volumes/domains,
 * and kicks off a deploy. The deploy happens async — caller gets back the
 * appId immediately with a 202-style response.
 */
export async function provisionService(
  pluginId: string,
  service: ServiceRequirement,
  organizationId: string,
): Promise<{ appId: string }> {
  const templateName = service.templateName ?? service.name;

  // Check if already provisioned
  const existingAppId = await getPluginSetting(
    pluginId,
    `provisionedAppId:${service.name}`,
    organizationId,
  );
  if (existingAppId) {
    const existingApp = await db.query.apps.findFirst({
      where: and(eq(apps.id, existingAppId), eq(apps.organizationId, organizationId)),
      columns: { id: true },
    });
    if (existingApp) {
      log.info(`Service ${service.name} already provisioned as app ${existingAppId}`);
      return { appId: existingAppId };
    }
    // Stale reference — clear it and re-provision
    log.warn(`Stale provisioned app reference ${existingAppId} for ${service.name}, re-provisioning`);
  }

  // Load template
  const templates = await loadTemplates();
  const template = templates.find((t) => t.name === templateName);
  if (!template) {
    throw new Error(`No template "${templateName}" found for service ${service.name}`);
  }

  // Get org for base domain
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
    columns: { id: true, baseDomain: true },
  });
  if (!org) {
    throw new Error("Organization not found");
  }

  // Create app
  const appId = nanoid();
  const appName = template.name;

  await db.insert(apps).values({
    id: appId,
    organizationId,
    name: appName,
    displayName: template.displayName,
    description: template.description,
    source: template.source as "git" | "direct",
    deployType: template.deployType as "compose" | "image",
    imageName: template.imageName,
    composeContent: template.composeContent,
    containerPort: template.defaultPort,
    templateName: template.name,
    cpuLimit: template.defaultCpuLimit,
    memoryLimit: template.defaultMemoryLimit,
    diskWriteAlertThreshold: template.defaultDiskWriteAlertThreshold,
    persistentVolumes: template.defaultVolumes?.map((v) => ({
      name: v.name,
      mountPath: v.mountPath,
    })),
    connectionInfo: template.defaultConnectionInfo,
  });

  // Create production environment
  await db.insert(environments).values({
    id: nanoid(),
    appId,
    name: "production",
    type: "production",
    isDefault: true,
  });

  // Create volumes
  if (template.defaultVolumes?.length) {
    for (const vol of template.defaultVolumes) {
      await db.insert(volumes).values({
        id: nanoid(),
        appId,
        organizationId,
        name: vol.name,
        mountPath: vol.mountPath,
        persistent: true,
      });
    }
  }

  // Auto-generate domain
  const sslConfig = await getSslConfig();
  const autoDomain = generateSubdomain(appName, org.baseDomain);
  if (autoDomain) {
    await db.insert(domains).values({
      id: nanoid(),
      appId,
      domain: autoDomain,
      port: template.defaultPort,
      certResolver: getPrimaryIssuer(sslConfig),
    });
  }

  // Store the provisioned app ID as a plugin setting
  await setPluginSetting(
    pluginId,
    `provisionedAppId:${service.name}`,
    appId,
    organizationId,
  );

  log.info(`Provisioned ${service.name} as app ${appId} for plugin ${pluginId}`);

  // Kick off deploy (fire-and-forget — caller gets 202)
  requestDeploy({
    appId,
    organizationId,
    trigger: "manual",
    triggeredBy: "system",
  }).catch((err) => {
    log.error(`Deploy failed for provisioned service ${service.name}:`, err);
  });

  return { appId };
}

/**
 * Deprovision a previously provisioned backing service.
 *
 * Stops the container, deletes the app record, and clears the plugin setting.
 */
export async function deprovisionService(
  pluginId: string,
  serviceName: string,
  organizationId: string,
): Promise<void> {
  const appId = await getPluginSetting(
    pluginId,
    `provisionedAppId:${serviceName}`,
    organizationId,
  );

  if (!appId) {
    log.info(`No provisioned app found for ${serviceName} in plugin ${pluginId}`);
    return;
  }

  // Look up the app to get its name for container stop
  const app = await db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, organizationId)),
    columns: { id: true, name: true },
  });

  if (app) {
    // Stop containers and remove volumes
    try {
      await stopProject(app.id, app.name, undefined, true);
    } catch {
      // Containers may not be running
    }

    // Delete app record (FK cascade handles related records)
    await db.delete(apps).where(
      and(eq(apps.id, appId), eq(apps.organizationId, organizationId)),
    );

    log.info(`Deleted provisioned app ${appId} (${app.name}) for plugin ${pluginId}`);
  }

  // Remove the plugin setting entirely
  await deletePluginSetting(
    pluginId,
    `provisionedAppId:${serviceName}`,
    organizationId,
  );
}
