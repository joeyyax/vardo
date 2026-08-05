// ---------------------------------------------------------------------------
// Core service provisioning
//
// cAdvisor, Loki and Promtail get one row each, in the Vardo system org, shared
// by every organization — see core-services.ts for why each is instance-wide.
// The lookup is by app name across the whole instance, so an existing row is
// adopted wherever it already lives instead of being duplicated or skipped.
//
// Called at startup (instrumentation.ts) and on feature flag toggle.
// ---------------------------------------------------------------------------

import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db } from "@/lib/db";
import { apps, environments, projects } from "@/lib/db/schema";
import { isAppNameViolation } from "@/lib/db/app-name";
import { isFeatureEnabledAsync, type FeatureFlag } from "@/lib/config/features";
import { loadTemplates, type Template } from "@/lib/templates/load";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { deleteApp } from "@/lib/docker/delete-app";
import { ensureVardoOrg } from "@/lib/infra/vardo-org";
import {
  CORE_SERVICE_FEATURES,
  recordCoreServiceStatus,
  type CoreServiceFeature,
  type CoreServiceState,
} from "@/lib/infra/core-services";
import { logger } from "@/lib/logger";

const log = logger.child("infra");

/** Statuses that mean an enabled core service is not running. */
const DOWN_STATUSES = ["missing", "error", "stopped"];

/** What one service ended up as, and enough context to report or undo it. */
type Outcome = {
  state: CoreServiceState;
  appId: string | null;
  organizationId: string | null;
  detail: string | null;
  /** True when this call created the row, so the caller can roll it back. */
  created: boolean;
};

/** Drop the rollback-only field so an outcome can be stored as a status. */
function toStatus(outcome: Outcome) {
  return {
    state: outcome.state,
    appId: outcome.appId,
    organizationId: outcome.organizationId,
    detail: outcome.detail,
  };
}

/**
 * Ensure every enabled core service is provisioned.
 * Safe to call on every startup — all writes are idempotent.
 */
export async function ensureInfraServices(): Promise<void> {
  const org = await ensureVardoOrg();
  if (!org) {
    log.info("No admin user yet, skipping core service provisioning");
    return;
  }

  const templates = await loadTemplates();
  const statuses: Parameters<typeof recordCoreServiceStatus>[0] = [];

  for (const feature of CORE_SERVICE_FEATURES) {
    const enabled = await isFeatureEnabledAsync(feature.flag);
    if (!enabled) continue;

    for (const service of feature.services) {
      const template = templates.find((t) => t.name === service.name);
      let outcome: Outcome;
      if (!template) {
        outcome = {
          state: "missing-template",
          appId: null,
          organizationId: null,
          detail: `Built-in template "${service.name}" is missing from this build.`,
          created: false,
        };
        log.warn(`Template "${service.name}" not found, skipping`);
      } else {
        try {
          outcome = await ensureAppDeployed(org.id, feature, template);
        } catch (err) {
          outcome = {
            state: "failed",
            appId: null,
            organizationId: null,
            detail: err instanceof Error ? err.message : String(err),
            created: false,
          };
          log.error(`Failed to provision ${service.name}:`, err);
        }
      }

      statuses.push({ ...service, flag: feature.flag, ...toStatus(outcome) });
      if (outcome.state !== "provisioned") log.warn(`Core service "${service.name}": ${outcome.detail}`);
    }
  }

  await recordCoreServiceStatus(statuses);
}

/**
 * Provision the core services a feature flag turns on.
 * Called from the feature flags API route after a toggle. Throws with an
 * operator-readable message so the route can revert the flag and say why.
 */
export async function provisionForFlag(flag: FeatureFlag, enabled: boolean): Promise<void> {
  if (!enabled) return; // Containers keep running when feature is disabled

  const feature = CORE_SERVICE_FEATURES.find((f) => f.flag === flag);
  if (!feature) return;

  const org = await ensureVardoOrg();
  if (!org) return;

  const templates = await loadTemplates();

  // Interactive toggle: wait for each first deploy and make the install
  // all-or-nothing. ensureAppDeployed rolls back its own app if its deploy
  // fails and throws; we then roll back any sibling apps already created in
  // this call so a partially-installed integration never lingers (#741).
  const created: { appId: string; organizationId: string }[] = [];
  const statuses: Parameters<typeof recordCoreServiceStatus>[0] = [];
  let failure: string | null = null;

  try {
    for (const service of feature.services) {
      const template = templates.find((t) => t.name === service.name);
      if (!template) {
        failure = `Built-in template "${service.name}" is missing from this build.`;
        statuses.push({
          ...service,
          flag,
          state: "missing-template",
          appId: null,
          organizationId: null,
          detail: failure,
        });
        break;
      }

      const outcome = await ensureAppDeployed(org.id, feature, template, { waitForDeploy: true });
      statuses.push({ ...service, flag, ...toStatus(outcome) });

      if (outcome.state !== "provisioned") {
        failure = outcome.detail;
        break;
      }
      if (outcome.created && outcome.appId && outcome.organizationId) {
        created.push({ appId: outcome.appId, organizationId: outcome.organizationId });
      }
    }
  } catch (err) {
    await recordCoreServiceStatus(statuses);
    for (const app of created) await rollbackInfraApp(app.appId, app.organizationId);
    throw err;
  }

  await recordCoreServiceStatus(statuses);

  if (failure) {
    for (const app of created) await rollbackInfraApp(app.appId, app.organizationId);
    throw new Error(failure);
  }
}

/**
 * Undo a provisioned core service app — used to roll back a failed first deploy.
 * Best-effort: a rollback failure is logged, never thrown.
 */
async function rollbackInfraApp(appId: string, orgId: string): Promise<void> {
  try {
    await deleteApp({ appId, organizationId: orgId, allowSystemManaged: true });
  } catch (err) {
    log.error(`Failed to roll back core service app ${appId}:`, err);
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

/**
 * Adopt or create the single app row for a core service.
 *
 * The name is a top-level app name, unique instance-wide, so the lookup isn't
 * scoped to an org: an existing system-managed row is adopted wherever it sits,
 * and a row owned by a regular app is reported as a conflict rather than
 * skipped. With `waitForDeploy`, awaits the first deploy and — on failure —
 * rolls back the app it just created and throws.
 */
async function ensureAppDeployed(
  orgId: string,
  feature: CoreServiceFeature,
  template: Template,
  opts?: { waitForDeploy?: boolean },
): Promise<Outcome> {
  const composeContent = await resolveComposeContent(template);
  const existing = await db.query.apps.findFirst({
    where: and(eq(apps.name, template.name), isNull(apps.parentAppId)),
    columns: {
      id: true,
      status: true,
      organizationId: true,
      isSystemManaged: true,
      composeContent: true,
    },
  });

  if (existing && !existing.isSystemManaged) {
    return {
      state: "conflict",
      appId: existing.id,
      organizationId: existing.organizationId,
      detail: `An app named "${template.name}" already exists on this instance, so the shared ${template.displayName} service can't be created. Rename or remove that app, then turn this back on.`,
      created: false,
    };
  }

  if (existing) {
    // For cadvisor: ensure gpuEnabled matches host GPU availability
    if (template.name === "cadvisor") {
      const hasGpu = await detectNvidiaGpu();
      await db.update(apps).set({ gpuEnabled: hasGpu }).where(eq(apps.id, existing.id));
      if (hasGpu) log.info(`cAdvisor: GPU detected, enabled GPU metrics`);
    }

    // The template is the only source of truth for a core service — the app
    // API refuses edits to a system-managed row. Without this, a template fix
    // reaches new installs only and every existing instance stays broken.
    const composeStale = !!composeContent && existing.composeContent !== composeContent;
    if (composeStale) {
      await db
        .update(apps)
        .set({
          composeContent,
          needsRedeploy: true,
          updatedAt: new Date(),
        })
        .where(eq(apps.id, existing.id));
      log.info(`Core service "${template.name}": compose refreshed from template`);
    }

    // Existence was the only check, so a core service whose container went away
    // stayed dead forever — the feature reads as enabled and silently does
    // nothing. Redeploy it instead. "stopped" counts: a disabled feature never
    // reaches here, so a stopped core service is one the flag still wants up.
    if (composeStale || DOWN_STATUSES.includes(existing.status)) {
      const reason = composeStale ? "compose changed" : `is ${existing.status}`;
      log.info(`Core service "${template.name}" ${reason} — redeploying`);
      let ok = false;
      try {
        const result = await requestDeploy({
          appId: existing.id,
          organizationId: existing.organizationId,
          trigger: "api",
        });
        ok = !!result?.success;
      } catch (err) {
        log.error(`Redeploy threw for core service "${template.name}":`, err);
      }
      if (!ok) log.error(`Redeploy failed for core service "${template.name}"`);
      return {
        state: ok ? "provisioned" : "failed",
        appId: existing.id,
        organizationId: existing.organizationId,
        detail: ok ? null : `${template.displayName} ${reason} and its redeploy failed.`,
        created: false,
      };
    }

    log.info(`Core service "${template.name}" already exists`);
    return {
      state: "provisioned",
      appId: existing.id,
      organizationId: existing.organizationId,
      detail: null,
      created: false,
    };
  }

  const project = await ensureProject(orgId, feature.project.name, feature.project.displayName);
  const appId = nanoid();

  // For cadvisor: detect GPU to enable NVML-based metrics
  const gpuEnabled = template.name === "cadvisor" ? await detectNvidiaGpu() : false;

  try {
    await db.insert(apps).values({
      id: appId,
      organizationId: orgId,
      projectId: project.id,
      name: template.name,
      displayName: template.displayName,
      description: template.description,
      source: template.source as "git" | "direct",
      deployType: template.deployType as "compose",
      composeContent,
      containerPort: template.defaultPort,
      isSystemManaged: true,
      cpuLimit: template.defaultCpuLimit,
      memoryLimit: template.defaultMemoryLimit,
      diskWriteAlertThreshold: template.defaultDiskWriteAlertThreshold,
      gpuEnabled,
    });
  } catch (err) {
    // Unique constraint violation — a concurrent call already created it
    if (isAppNameViolation(err) || (err instanceof Error && err.message.includes("unique"))) {
      log.info(`Core service "${template.name}" already created by concurrent call`);
      return { state: "provisioned", appId: null, organizationId: orgId, detail: null, created: false };
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

  log.info(`Created core service "${template.name}", triggering deploy`);

  if (opts?.waitForDeploy) {
    // Interactive install (#741): wait for the first deploy and roll back the
    // app on failure so it isn't left as a connected-but-broken integration.
    let result: Awaited<ReturnType<typeof requestDeploy>> | null = null;
    try {
      result = await requestDeploy({ appId, organizationId: orgId, trigger: "api" });
    } catch (err) {
      log.error(`Deploy threw for core service "${template.name}":`, err);
    }
    if (!result?.success) {
      log.error(`First deploy failed for core service "${template.name}" — rolling back`);
      await rollbackInfraApp(appId, orgId);
      throw new Error(`${template.displayName} failed to deploy.`);
    }
    return { state: "provisioned", appId, organizationId: orgId, detail: null, created: true };
  }

  // Startup reconcile: fire-and-forget so boot isn't blocked by a slow or
  // failing deploy.
  requestDeploy({
    appId,
    organizationId: orgId,
    trigger: "api",
  }).catch((err) => {
    log.error(`Deploy failed for core service "${template.name}":`, err);
  });
  return { state: "provisioned", appId, organizationId: orgId, detail: null, created: true };
}

/**
 * Compose content to store for a template, adjusted for cadvisor's disk
 * metrics setting. Every other template passes through unchanged.
 */
async function resolveComposeContent(template: Template): Promise<string | null> {
  if (template.name !== "cadvisor" || !template.composeContent) return template.composeContent;
  const { getCadvisorConfig, applyCadvisorDiskMetrics } = await import("@/lib/infra/cadvisor-config");
  const { diskMetricsEnabled } = await getCadvisorConfig();
  return applyCadvisorDiskMetrics(template.composeContent, diskMetricsEnabled);
}

/** Check if an NVIDIA GPU runtime is available on the Docker host. */
async function detectNvidiaGpu(): Promise<boolean> {
  try {
    const { execFileAsync } = await import("@/lib/utils/exec");
    const { stdout } = await execFileAsync("docker", ["info", "--format", "{{json .Runtimes}}"], { timeout: 5000 });
    return stdout.includes("nvidia");
  } catch {
    return false;
  }
}
