// ---------------------------------------------------------------------------
// PR preview lifecycle
//
// Creates and destroys preview environments for GitHub pull requests.
// A preview covers the PR repo's apps, their compose children and their
// declared dependencies (see preview-scope.ts).
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { apps, groupEnvironments } from "@/lib/db/schema";
import { eq, and, ilike } from "drizzle-orm";
import {
  createGroupEnvironment,
  destroyGroupEnvironment,
} from "./clone";
import { deployGroup } from "./deploy-group";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { logger } from "@/lib/logger";
import { matchesGitHubRepo, previewScope } from "./preview-scope";
import {
  acquirePreviewLock,
  clearPreviewClosed,
  isPreviewClosed,
  markPreviewClosed,
} from "./preview-lock";

const log = logger.child("preview");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CreatePreviewOpts = {
  /** GitHub repo full name (owner/repo) */
  repoFullName: string;
  /** PR number */
  prNumber: number;
  /** PR URL */
  prUrl: string;
  /** Branch being merged */
  branch: string;
  /** Who opened the PR */
  author?: string;
  /** How long before auto-cleanup (default: 7 days) */
  ttlDays?: number;
};

type PreviewResult = {
  groupEnvironmentId: string;
  domains: { appName: string; domain: string }[];
  deployed: boolean;
};

export type { CreatePreviewOpts, PreviewResult };

// ---------------------------------------------------------------------------
// Create preview
// ---------------------------------------------------------------------------

/** Run `fn` under the PR's lock. Without Redis it runs unlocked, as it always did. */
async function withPreviewLock<T>(
  repoFullName: string,
  prNumber: number,
  fn: () => Promise<T>,
  whenBusy: T,
): Promise<T> {
  let lock;
  try {
    lock = await acquirePreviewLock(repoFullName, prNumber);
  } catch (err) {
    log.warn(`Preview lock for PR #${prNumber} unavailable, running unlocked:`, err);
    return fn();
  }
  if (!lock) {
    log.warn(`PR #${prNumber}: another preview operation held the lock too long, skipping`);
    return whenBusy;
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/** Apps built from this GitHub repo, whatever form their git URL takes. */
async function appsForRepo(repoFullName: string) {
  const candidates = await db.query.apps.findMany({
    where: ilike(apps.gitUrl, `%${repoFullName}%`),
  });
  return candidates.filter((a) => matchesGitHubRepo(a.gitUrl, repoFullName));
}

/**
 * Create or redeploy the preview environment for a PR.
 *
 * Serialized with destroyPreview per PR. A close that lands mid-create is
 * honoured at the next step: whatever was built is torn down.
 */
export async function createPreview(
  opts: CreatePreviewOpts
): Promise<PreviewResult | null> {
  if (!(await isFeatureEnabledAsync("previews"))) {
    log.info("Previews are disabled, skipping preview creation");
    return null;
  }

  // A preview is a non-production environment, so it needs the environments flag.
  if (!(await isFeatureEnabledAsync("environments"))) {
    log.info("Environments are disabled, skipping preview creation");
    return null;
  }

  // An open after a close supersedes it.
  await clearPreviewClosed(opts.repoFullName, opts.prNumber).catch(() => {});
  return withPreviewLock(opts.repoFullName, opts.prNumber, () => createPreviewLocked(opts), null);
}

async function createPreviewLocked(
  opts: CreatePreviewOpts
): Promise<PreviewResult | null> {
  const closed = () => isPreviewClosed(opts.repoFullName, opts.prNumber);
  if (await closed()) return null;

  const matchingApps = await appsForRepo(opts.repoFullName);
  if (matchingApps.length === 0) return null;

  // Find the first app that belongs to a project.
  // The PR branch gets deployed into the preview — we don't filter by
  // the app's configured gitBranch since any repo app can be previewed.
  const groupedApp = matchingApps.find((a) => a.projectId);
  if (!groupedApp || !groupedApp.projectId) {
    // No project — can't create a group preview for standalone apps
    return null;
  }

  const projectId = groupedApp.projectId;
  const organizationId = groupedApp.organizationId;
  const envName = `pr-${opts.prNumber}`;
  const ttlDays = opts.ttlDays ?? 7;

  const abandon = async (groupEnvironmentId: string) => {
    log.info(`PR #${opts.prNumber} closed during create — tearing the preview down`);
    await destroyGroupEnvironment(groupEnvironmentId, organizationId).catch((err) =>
      log.error(`Teardown after close failed for PR #${opts.prNumber}:`, err),
    );
    return null;
  };

  // Check if preview already exists
  const existing = await db.query.groupEnvironments.findFirst({
    where: and(
      eq(groupEnvironments.projectId, projectId),
      eq(groupEnvironments.name, envName)
    ),
  });

  if (existing) {
    // Preview already exists — could be a push to an existing PR
    // Re-deploy the project in the existing environment
    try {
      await deployGroup({
        projectId,
        organizationId,
        trigger: "webhook",
        groupEnvironmentId: existing.id,
      });
    } catch (err) {
      log.error(`Re-deploy failed for PR #${opts.prNumber}:`, err);
    }
    if (await closed()) return abandon(existing.id);

    return {
      groupEnvironmentId: existing.id,
      domains: [],
      deployed: true,
    };
  }

  const projectApps = await db.query.apps.findMany({
    where: eq(apps.projectId, projectId),
    columns: { id: true, name: true, gitUrl: true, parentAppId: true, dependsOn: true, cloneStrategy: true },
  });
  const appIds = [...previewScope(projectApps, opts.repoFullName)];

  // The PR branch goes on the repo's own apps; dependencies deploy their usual branch.
  const appOverrides: Record<string, { gitBranch: string }> = {};
  for (const app of matchingApps) {
    if (app.projectId === projectId) {
      appOverrides[app.id] = { gitBranch: opts.branch };
    }
  }

  // Create new preview environment
  const result = await createGroupEnvironment({
    projectId,
    organizationId,
    name: envName,
    type: "preview",
    appIds,
    appOverrides,
    prNumber: opts.prNumber,
    prUrl: opts.prUrl,
    expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
  });
  if (await closed()) return abandon(result.groupEnvironmentId);

  // Deploy the preview
  let deployed = false;
  try {
    await deployGroup({
      projectId,
      organizationId,
      trigger: "webhook",
      groupEnvironmentId: result.groupEnvironmentId,
    });
    deployed = true;
  } catch (err) {
    log.error(`Deploy failed for PR #${opts.prNumber}:`, err);
  }
  if (await closed()) return abandon(result.groupEnvironmentId);

  // Collect domains
  const domains = result.projectEnvironments
    .filter((pe) => pe.domain)
    .map((pe) => ({
      appName: pe.appName,
      domain: pe.domain!,
    }));

  return {
    groupEnvironmentId: result.groupEnvironmentId,
    domains,
    deployed,
  };
}

// ---------------------------------------------------------------------------
// Destroy preview
// ---------------------------------------------------------------------------

/**
 * Destroy a preview environment when a PR is closed/merged.
 *
 * Runs with previews off so a close still removes an existing preview. Only a
 * `type: "preview"` group environment named `pr-<n>` is ever touched.
 */
export async function destroyPreview(
  repoFullName: string,
  prNumber: number
): Promise<boolean> {
  const marked = await markPreviewClosed(repoFullName, prNumber).then(
    () => true,
    () => false,
  );
  return withPreviewLock(
    repoFullName,
    prNumber,
    async () => {
      // Reopened while this waited for the lock: the open wins.
      if (marked && !(await isPreviewClosed(repoFullName, prNumber))) return false;
      return destroyPreviewLocked(repoFullName, prNumber);
    },
    false,
  );
}

async function destroyPreviewLocked(
  repoFullName: string,
  prNumber: number
): Promise<boolean> {
  const matchingApps = await appsForRepo(repoFullName);
  const groupedApp = matchingApps.find((a) => a.projectId);
  if (!groupedApp || !groupedApp.projectId) return false;

  const envName = `pr-${prNumber}`;

  // Find the preview environment
  const groupEnv = await db.query.groupEnvironments.findFirst({
    where: and(
      eq(groupEnvironments.projectId, groupedApp.projectId),
      eq(groupEnvironments.name, envName),
      eq(groupEnvironments.type, "preview")
    ),
  });

  if (!groupEnv) return false;

  await destroyGroupEnvironment(
    groupEnv.id,
    groupedApp.organizationId
  );

  return true;
}

// ---------------------------------------------------------------------------
// Cleanup expired previews
// ---------------------------------------------------------------------------

/**
 * Find and destroy all expired preview environments.
 * Call this from a cron job.
 */
export async function cleanupExpiredPreviews(): Promise<number> {
  if (!(await isFeatureEnabledAsync("previews"))) return 0;

  const now = new Date();

  const expired = await db.query.groupEnvironments.findMany({
    where: eq(groupEnvironments.type, "preview"),
    with: {
      project: {
        columns: { organizationId: true },
      },
    },
  });

  let cleaned = 0;
  for (const env of expired) {
    if (env.expiresAt && env.expiresAt < now) {
      try {
        await destroyGroupEnvironment(env.id, env.project.organizationId);
        cleaned++;
        log.info(`Cleaned up expired preview: ${env.name}`);
      } catch (err) {
        log.error(`Cleanup failed for ${env.name}:`, err);
      }
    }
  }

  return cleaned;
}
