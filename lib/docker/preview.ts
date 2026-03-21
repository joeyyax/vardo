// ---------------------------------------------------------------------------
// PR preview lifecycle
//
// Creates and destroys preview environments for GitHub pull requests.
// A preview clones the entire project's environment so the PR gets a
// fully functional stack.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { apps, groupEnvironments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  createGroupEnvironment,
  destroyGroupEnvironment,
} from "./clone";
import { deployGroup } from "./deploy-group";

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

/**
 * Create a preview environment for a PR.
 *
 * 1. Find app(s) matching the repo + branch
 * 2. If app is in a project, clone the entire project as a preview
 * 3. Deploy the preview project
 * 4. Return preview URLs
 */
export async function createPreview(
  opts: CreatePreviewOpts
): Promise<PreviewResult | null> {
  const gitUrl = `https://github.com/${opts.repoFullName}.git`;

  // Find apps matching this repo
  const matchingApps = await db.query.apps.findMany({
    where: eq(apps.gitUrl, gitUrl),
  });

  // Filter to matching branch
  const branchApps = matchingApps.filter(
    (a) => (a.gitBranch || "main") === opts.branch
  );

  if (branchApps.length === 0) return null;

  // Find the first app that belongs to a project
  const groupedApp = branchApps.find((a) => a.projectId);
  if (!groupedApp || !groupedApp.projectId) {
    // No project — can't create a group preview for standalone apps
    return null;
  }

  const projectId = groupedApp.projectId;
  const organizationId = groupedApp.organizationId;
  const envName = `pr-${opts.prNumber}`;
  const ttlDays = opts.ttlDays ?? 7;

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
      console.error(`[preview] Re-deploy failed for PR #${opts.prNumber}:`, err);
    }

    return {
      groupEnvironmentId: existing.id,
      domains: [],
      deployed: true,
    };
  }

  // Create new preview environment
  const result = await createGroupEnvironment({
    projectId,
    organizationId,
    name: envName,
    type: "preview",
    prNumber: opts.prNumber,
    prUrl: opts.prUrl,
    expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
  });

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
    console.error(`[preview] Deploy failed for PR #${opts.prNumber}:`, err);
  }

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
 */
export async function destroyPreview(
  repoFullName: string,
  prNumber: number
): Promise<boolean> {
  const gitUrl = `https://github.com/${repoFullName}.git`;

  // Find apps matching this repo
  const matchingApps = await db.query.apps.findMany({
    where: eq(apps.gitUrl, gitUrl),
  });

  const groupedApp = matchingApps.find((a) => a.projectId);
  if (!groupedApp || !groupedApp.projectId) return false;

  const envName = `pr-${prNumber}`;

  // Find the preview environment
  const groupEnv = await db.query.groupEnvironments.findFirst({
    where: and(
      eq(groupEnvironments.projectId, groupedApp.projectId),
      eq(groupEnvironments.name, envName)
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
        console.log(`[preview] Cleaned up expired preview: ${env.name}`);
      } catch (err) {
        console.error(`[preview] Cleanup failed for ${env.name}:`, err);
      }
    }
  }

  return cleaned;
}
