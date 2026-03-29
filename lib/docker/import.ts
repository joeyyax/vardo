// ---------------------------------------------------------------------------
// Shared helpers for the container/compose-group import routes.
//
// Both routes share the same project-resolution logic, async stop→deploy→
// rollback migration pattern, and PG error code extraction. Centralizing
// them here keeps each route handler focused on its own concerns.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { apps, deployments, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { slugify } from "@/lib/ui/slugify";
import { stopContainer, startContainer, removeContainer } from "@/lib/docker/client";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { publishEvent, appChannel } from "@/lib/events";
import { recordActivity } from "@/lib/activity";

// Infer the Drizzle transaction type from the db.transaction callback signature.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Project resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the project ID for an import operation.
 *
 * - If `newProjectName` is provided, a new project is created and its ID is
 *   returned.
 * - If `projectId` is provided, it is verified to belong to `orgId` and
 *   returned unchanged.
 * - Otherwise `null` is returned (no project).
 *
 * Throws `Error("PROJECT_NOT_FOUND")` when a non-null `projectId` does not
 * exist in the org.  The caller is responsible for translating this into an
 * HTTP 400 response.
 */
export async function resolveProjectForImport(
  tx: Tx,
  orgId: string,
  projectId: string | null | undefined,
  newProjectName: string | undefined,
): Promise<string | null> {
  if (newProjectName) {
    const newProjectId = nanoid();
    await tx.insert(projects).values({
      id: newProjectId,
      organizationId: orgId,
      name: slugify(newProjectName),
      displayName: newProjectName,
    });
    return newProjectId;
  }

  if (projectId) {
    const project = await tx.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { id: true },
    });
    if (!project) {
      throw new Error("PROJECT_NOT_FOUND");
    }
    return projectId;
  }

  return null;
}

// ---------------------------------------------------------------------------
// PG error helpers
// ---------------------------------------------------------------------------

/**
 * Extract the PostgreSQL error code from an unknown thrown value.
 * Checks both the error itself and `error.cause` for the `code` property.
 */
export function getPgErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const directCode =
    "code" in error ? (error as { code: string }).code : null;
  if (directCode) return directCode;
  if (
    error.cause &&
    typeof error.cause === "object" &&
    "code" in error.cause
  ) {
    return (error.cause as { code: string }).code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Async container migration
// ---------------------------------------------------------------------------

export type MigrationParams = {
  /** IDs of the original containers to stop and (on success) remove. */
  containerIds: string[];
  appId: string;
  deploymentId: string;
  orgId: string;
  userId: string;
  displayName: string;
  /** Extra fields merged into the `deployment.rolled_back` activity metadata. */
  activityMetadata: Record<string, unknown>;
  /**
   * When true, if the first container fails to stop the migration is aborted
   * without attempting a deploy. Appropriate for single-container imports where
   * a port conflict makes the deploy pointless.
   * Defaults to false (group import: attempt deploy even if some stops fail).
   */
  bailOnFirstStopFailure?: boolean;
};

/**
 * Fire-and-forget async container migration.
 *
 * Stops all containers in `containerIds`, triggers a deploy, then removes the
 * originals on success. On any deploy failure the stopped containers are
 * restarted and the deployment is marked as rolled_back.
 *
 * This function returns immediately after scheduling the work. It must NOT be
 * awaited by the HTTP request handler — call it after the response has been
 * sent so the HTTP connection is not held open.
 */
export function runAsyncContainerMigration(params: MigrationParams): void {
  const {
    containerIds,
    appId,
    deploymentId,
    orgId,
    userId,
    displayName,
    activityMetadata,
    bailOnFirstStopFailure = false,
  } = params;

  void (async () => {
    const stoppedIds: string[] = [];

    for (const containerId of containerIds) {
      try {
        await stopContainer(containerId);
        stoppedIds.push(containerId);
      } catch {
        // If we can't stop a container, optionally bail so the deploy is not
        // attempted with the original still running (e.g. port conflicts).
        if (bailOnFirstStopFailure) return;
      }
    }

    try {
      const deployResult = await requestDeploy({
        appId,
        organizationId: orgId,
        trigger: "api",
        triggeredBy: userId,
        deploymentId,
      });

      if (!deployResult.success) {
        throw new Error(deployResult.log || "Deployment did not succeed");
      }
    } catch {
      // Restart originals so services keep running while the operator
      // investigates.
      if (stoppedIds.length > 0) {
        let anyRestarted = false;
        for (const containerId of stoppedIds) {
          try {
            await startContainer(containerId);
            anyRestarted = true;
          } catch {
            // Best effort.
          }
        }

        if (anyRestarted) {
          await db
            .update(deployments)
            .set({ status: "rolled_back", finishedAt: new Date() })
            .where(eq(deployments.id, deploymentId));

          await db
            .update(apps)
            .set({ status: "active", updatedAt: new Date() })
            .where(eq(apps.id, appId));

          publishEvent(appChannel(appId), {
            event: "deploy:rolled_back",
            appId,
            deploymentId,
            message: "Import deploy failed — original containers restarted",
          }).catch(() => {});

          recordActivity({
            organizationId: orgId,
            action: "deployment.rolled_back",
            appId,
            metadata: { deploymentId, ...activityMetadata },
          }).catch(() => {});

          import("@/lib/notifications/dispatch")
            .then(({ emit }) => {
              emit(orgId, {
                type: "deploy.rollback",
                title: `Import deploy failed: ${displayName}`,
                message: "Import deploy failed — original containers restarted",
                projectName: displayName,
                appId,
                rollbackSuccess: true,
              });
            })
            .catch(() => {});
        }
      }
      return;
    }

    // Deployment succeeded — remove the original containers.
    for (const containerId of containerIds) {
      try {
        await removeContainer(containerId, { force: true });
      } catch {
        // Non-fatal — operator can remove manually.
      }
    }
  })();
}

// ---------------------------------------------------------------------------
// Env var parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Docker env array (`["KEY=VALUE", ...]`) into a plain object.
 *
 * Values containing `${` are omitted — Docker Compose would treat them as
 * variable substitution expressions, which would break the generated compose
 * file.  The caller should warn the user about skipped vars.
 */
export function parseContainerEnvVars(env: string[]): {
  vars: Record<string, string>;
  skippedKeys: string[];
} {
  const vars: Record<string, string> = {};
  const skippedKeys: string[] = [];

  for (const entry of env) {
    const idx = entry.indexOf("=");
    if (idx === -1) continue;
    const key = entry.slice(0, idx);
    const value = entry.slice(idx + 1);
    if (/\$\{/.test(value)) {
      skippedKeys.push(key);
    } else {
      vars[key] = value;
    }
  }

  return { vars, skippedKeys };
}
