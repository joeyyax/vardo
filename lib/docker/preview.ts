// ---------------------------------------------------------------------------
// PR preview lifecycle
//
// Creates and destroys preview environments for GitHub pull requests.
// A preview clones the entire group's environment so the PR gets a
// fully functional stack.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { projects, groupEnvironments } from "@/lib/db/schema";
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
  domains: { projectName: string; domain: string }[];
  deployed: boolean;
};

export type { CreatePreviewOpts, PreviewResult };

// ---------------------------------------------------------------------------
// Create preview
// ---------------------------------------------------------------------------

/**
 * Create a preview environment for a PR.
 *
 * 1. Find project(s) matching the repo + branch
 * 2. If project is in a group, clone the entire group as a preview
 * 3. Deploy the preview group
 * 4. Return preview URLs
 */
export async function createPreview(
  opts: CreatePreviewOpts
): Promise<PreviewResult | null> {
  const gitUrl = `https://github.com/${opts.repoFullName}.git`;

  // Find projects matching this repo
  const matchingProjects = await db.query.projects.findMany({
    where: eq(projects.gitUrl, gitUrl),
  });

  // Filter to matching branch
  const branchProjects = matchingProjects.filter(
    (p) => (p.gitBranch || "main") === opts.branch
  );

  if (branchProjects.length === 0) return null;

  // Find the first project that belongs to a group
  const groupedProject = branchProjects.find((p) => p.parentId);
  if (!groupedProject || !groupedProject.parentId) {
    // No group — can't create a group preview for standalone projects
    return null;
  }

  const groupId = groupedProject.parentId;
  const organizationId = groupedProject.organizationId;
  const envName = `pr-${opts.prNumber}`;
  const ttlDays = opts.ttlDays ?? 7;

  // Check if preview already exists
  const existing = await db.query.groupEnvironments.findFirst({
    where: and(
      eq(groupEnvironments.parentProjectId, groupId),
      eq(groupEnvironments.name, envName)
    ),
  });

  if (existing) {
    // Preview already exists — could be a push to an existing PR
    // Re-deploy the group in the existing environment
    try {
      await deployGroup({
        parentProjectId: groupId,
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
    parentProjectId: groupId,
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
      parentProjectId: groupId,
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
      projectName: pe.projectName,
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

  // Find projects matching this repo
  const matchingProjects = await db.query.projects.findMany({
    where: eq(projects.gitUrl, gitUrl),
  });

  const groupedProject = matchingProjects.find((p) => p.parentId);
  if (!groupedProject || !groupedProject.parentId) return false;

  const envName = `pr-${prNumber}`;

  // Find the preview environment
  const groupEnv = await db.query.groupEnvironments.findFirst({
    where: and(
      eq(groupEnvironments.parentProjectId, groupedProject.parentId),
      eq(groupEnvironments.name, envName)
    ),
  });

  if (!groupEnv) return false;

  await destroyGroupEnvironment(
    groupEnv.id,
    groupedProject.organizationId
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
      parentProject: {
        columns: { organizationId: true },
      },
    },
  });

  let cleaned = 0;
  for (const env of expired) {
    if (env.expiresAt && env.expiresAt < now) {
      try {
        await destroyGroupEnvironment(env.id, env.parentProject.organizationId);
        cleaned++;
        console.log(`[preview] Cleaned up expired preview: ${env.name}`);
      } catch (err) {
        console.error(`[preview] Cleanup failed for ${env.name}:`, err);
      }
    }
  }

  return cleaned;
}
