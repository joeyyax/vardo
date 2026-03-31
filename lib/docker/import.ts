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
import { stopContainer, startContainer, removeContainer, inspectContainer } from "@/lib/docker/client";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { publishEvent, appChannel } from "@/lib/events";
import { recordActivity } from "@/lib/activity";
import type { ComposeFile } from "@/lib/docker/compose";

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
// Container stop verification
// ---------------------------------------------------------------------------

const STOP_POLL_INTERVAL_MS = 250;
const STOP_POLL_MAX_WAIT_MS = 5000;

/**
 * Poll the container state until it reaches a terminal status ("exited" or
 * "dead"), or until the timeout expires. Docker's stop API blocks until the
 * main process exits, but the engine may not have fully released resources
 * (port bindings, network namespace) by the time it returns. Polling ensures
 * the deploy that follows doesn't hit lock or port conflicts.
 */
async function waitForContainerStopped(containerId: string): Promise<void> {
  const deadline = Date.now() + STOP_POLL_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const info = await inspectContainer(containerId);
      if (info.state.status === "exited" || info.state.status === "dead") return;
    } catch {
      // Container removed or not found — treat as stopped.
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, STOP_POLL_INTERVAL_MS));
  }
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
        // Docker's stop API returns once the main process exits, but the engine
        // may not have fully released port bindings and other resources yet.
        // Wait until the container reaches a terminal state before deploying
        // to avoid lock or port conflicts with the incoming Vardo container.
        await waitForContainerStopped(containerId);
        stoppedIds.push(containerId);
      } catch {
        // If we can't stop a container, optionally bail so the deploy is not
        // attempted with the original still running (e.g. port conflicts).
        if (bailOnFirstStopFailure) {
          // Restart any containers we already stopped so services keep running.
          for (const id of stoppedIds) {
            try { await startContainer(id); } catch { /* best effort */ }
          }

          await db.transaction(async (tx) => {
            await tx
              .update(deployments)
              .set({ status: "failed", finishedAt: new Date() })
              .where(eq(deployments.id, deploymentId));

            await tx
              .update(apps)
              .set({ status: "active", updatedAt: new Date() })
              .where(eq(apps.id, appId));
          });

          publishEvent(appChannel(appId), {
            event: "deploy:failed",
            appId,
            deploymentId,
            message: "Import migration aborted — could not stop original container",
          }).catch(() => {});

          return;
        }
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
// Compose group helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a network name is the default network created by a Docker
 * Compose project. Compose generates networks named `{project}_default` (or
 * just `{project}` in some older versions). These networks are ephemeral —
 * they won't exist after the original containers are removed, so referencing
 * them as `external: true` in the imported compose file would cause deploy
 * failures.
 */
export function isComposeProjectNetwork(networkName: string, composeProject: string): boolean {
  if (!networkName || !composeProject) return false;
  const lower = networkName.toLowerCase();
  const project = composeProject.toLowerCase();
  return lower === `${project}_default` || lower === project;
}

/**
 * Parse the `com.docker.compose.depends_on` label into a depends_on object
 * that preserves condition info. Docker Compose stores dependency info as a
 * comma-separated list of `service:condition:restart` triples (e.g.
 * "redis:service_started:false,postgres:service_healthy:false").
 *
 * Returns an empty object if the label is absent or empty.
 */
export function parseComposeDependsOn(
  labels: Record<string, string>,
): Record<string, { condition: "service_healthy" | "service_started" | "service_completed_successfully" }> {
  const raw = labels["com.docker.compose.depends_on"];
  if (!raw) return {};

  const result: Record<string, { condition: "service_healthy" | "service_started" | "service_completed_successfully" }> = {};
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const [serviceName, condition] = entry.split(":");
    if (!serviceName) continue;
    const cond = (condition?.trim() ?? "service_started") as
      | "service_healthy"
      | "service_started"
      | "service_completed_successfully";
    result[serviceName.trim()] = { condition: cond };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Env var parsing
// ---------------------------------------------------------------------------

/**
 * Returns true when an env var key name suggests it holds a sensitive value
 * (password, token, secret, private key, API key, credential, etc.).
 *
 * Used during container import to route sensitive vars to the encrypted
 * envContent field rather than inlining them in plaintext compose content.
 * The match is intentionally broad — false positives are safer than misses.
 */
export function isSensitiveEnvKey(key: string): boolean {
  return /password|passwd|secret|token|private_key|api_key|access_key|credential|url|uri|dsn|connection/i.test(key);
}

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

// ---------------------------------------------------------------------------
// Compose file merging
// ---------------------------------------------------------------------------

/**
 * Merge services, volumes, and networks from `source` into `target`.
 *
 * When `composeProject` is provided, networks matching the compose project's
 * default network pattern are excluded — they are ephemeral and will not exist
 * after the original containers are removed.
 */
export function mergeComposeFile(
  target: ComposeFile,
  source: ComposeFile,
  composeProject?: string,
): void {
  for (const [name, svc] of Object.entries(source.services)) {
    target.services[name] = svc;
  }

  if (source.volumes) {
    target.volumes ??= {};
    for (const [volName, volDef] of Object.entries(source.volumes)) {
      target.volumes[volName] = volDef;
    }
  }

  if (source.networks) {
    target.networks ??= {};
    for (const [netName, netDef] of Object.entries(source.networks)) {
      if (!composeProject || !isComposeProjectNetwork(netName, composeProject)) {
        target.networks[netName] = netDef;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Git repo detection for compose projects
// ---------------------------------------------------------------------------

import { readFile, access, constants } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { execFile } from "child_process";
import { parseCompose } from "@/lib/docker/compose";

const execFileAsync = promisify(execFile);

export type GitBuildContext = {
  gitUrl: string;
  gitBranch: string | null;
  hasBuildDirectives: boolean;
};

/**
 * Detect git repository info and build directives from a compose project directory.
 *
 * Reads the original docker-compose.yml from the working directory (if accessible),
 * checks for build: directives, and extracts the git remote URL.
 *
 * Returns null if the directory is not accessible or not a git repo.
 */
export async function detectGitBuildContext(
  workingDir: string,
  configFiles: string,
): Promise<GitBuildContext | null> {
  // Check if we have access to the directory
  try {
    await access(workingDir, constants.R_OK);
  } catch {
    return null; // Directory not accessible (not mounted or doesn't exist)
  }

  // Resolve compose file path (may be absolute or relative)
  const composeFile = configFiles.startsWith("/")
    ? configFiles
    : join(workingDir, configFiles.split(",")[0] ?? "docker-compose.yml");

  // Read and parse compose file
  let hasBuildDirectives = false;
  try {
    const content = await readFile(composeFile, "utf-8");
    const compose = parseCompose(content);
    hasBuildDirectives = Object.values(compose.services).some((svc) => svc.build);
  } catch {
    // Can't read compose file
    return null;
  }

  // Get git remote URL
  let gitUrl: string | null = null;
  let gitBranch: string | null = null;
  try {
    const { stdout: remoteUrl } = await execFileAsync(
      "git",
      ["-C", workingDir, "remote", "get-url", "origin"],
      { timeout: 5000 },
    );
    gitUrl = remoteUrl.trim();

    // Convert SSH URL to HTTPS if needed
    if (gitUrl.startsWith("git@")) {
      gitUrl = gitUrl.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");
    }

    // Get current branch
    const { stdout: branch } = await execFileAsync(
      "git",
      ["-C", workingDir, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: 5000 },
    );
    gitBranch = branch.trim();
    if (gitBranch === "HEAD") gitBranch = null; // Detached HEAD
  } catch {
    // Not a git repo or git not available
    return null;
  }

  if (!gitUrl) return null;

  return {
    gitUrl,
    gitBranch,
    hasBuildDirectives,
  };
}
