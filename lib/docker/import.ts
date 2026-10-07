// Shared helpers for the container and compose-group import routes.

import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { apps, deployments, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { slugify } from "@/lib/ui/slugify";
import { stopContainer, startContainer, removeContainer, inspectContainer } from "@/lib/docker/client";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { addEvent } from "@/lib/stream/producer";
import { recordActivity } from "@/lib/activity";
import type { ComposeFile } from "@/lib/docker/compose";
import { execFileAsync } from "@/lib/utils/exec";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Project ID for an import: creates `newProjectName` or verifies `projectId` in the org. Throws PROJECT_REQUIRED / PROJECT_NOT_FOUND. */
export async function resolveProjectForImport(
  tx: Tx,
  orgId: string,
  projectId: string | null | undefined,
  newProjectName: string | undefined,
): Promise<string> {
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

  throw new Error("PROJECT_REQUIRED");
}

export { getPgErrorCode, isUniqueViolation } from "@/lib/api/error-response";

const STOP_POLL_INTERVAL_MS = 250;
const STOP_POLL_MAX_WAIT_MS = 5000;

/** Poll until the container is exited or dead. Docker's stop returns before port bindings and the netns are released. */
async function waitForContainerStopped(containerId: string): Promise<void> {
  const deadline = Date.now() + STOP_POLL_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const info = await inspectContainer(containerId);
      if (info.state.status === "exited" || info.state.status === "dead") return;
    } catch {
      // Gone counts as stopped.
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, STOP_POLL_INTERVAL_MS));
  }
}

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
  /** Abort without deploying if the first stop fails (single-container imports). Defaults to false. */
  bailOnFirstStopFailure?: boolean;
};

/** Stop the originals, deploy, then remove them on success or restart them and mark rolled_back on failure. */
// Fire-and-forget: call after the HTTP response is sent, never await it.
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
        // Wait for a terminal state so the incoming container doesn't hit port conflicts.
        await waitForContainerStopped(containerId);
        stoppedIds.push(containerId);
      } catch {
        // Don't deploy with the original still running.
        if (bailOnFirstStopFailure) {
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
              .set(statusChange("active"))
              .where(eq(apps.id, appId));
          });

          addEvent(orgId, {
            type: "deploy.status",
            title: "Import failed",
            message: "Import migration aborted — could not stop original container",
            appId,
            deploymentId,
            status: "error",
            success: false,
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
      // Restart originals so services keep running.
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
          // Only the outcome changes; duration and finish time stay.
          await db
            .update(deployments)
            .set({ status: "rolled_back" })
            .where(eq(deployments.id, deploymentId));

          await db
            .update(apps)
            .set(statusChange("active"))
            .where(eq(apps.id, appId));

          addEvent(orgId, {
            type: "deploy.status",
            title: "Import rolled back",
            message: "Import deploy failed — original containers restarted",
            appId,
            deploymentId,
            status: "error",
            success: false,
          }).catch(() => {});

          recordActivity({
            organizationId: orgId,
            action: "deployment.rolled_back",
            appId,
            userId,
            metadata: {
              deploymentId,
              reason: "Import deploy failed — original containers restarted",
              ...activityMetadata,
            },
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

    for (const containerId of containerIds) {
      try {
        await removeContainer(containerId, { force: true });
      } catch {
        // Non-fatal.
      }
    }
  })();
}

/** Whether a network is a compose project's ephemeral default (`{project}_default` or `{project}`), which can't be `external: true`. */
export function isComposeProjectNetwork(networkName: string, composeProject: string): boolean {
  if (!networkName || !composeProject) return false;
  const lower = networkName.toLowerCase();
  const project = composeProject.toLowerCase();
  return lower === `${project}_default` || lower === project;
}

/** Parse `com.docker.compose.depends_on` (`service:condition:restart,...`) into depends_on with conditions. Empty when absent. */
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

/** Whether an env key looks sensitive. Deliberately broad: those go to encrypted envContent. */
export function isSensitiveEnvKey(key: string): boolean {
  return /password|passwd|secret|token|private_key|api_key|access_key|credential|url|uri|dsn|connection/i.test(key);
}

/** Parse `["KEY=VALUE", ...]` into an object. Values containing `${` are skipped; warn the user about them. */
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

/** Merge services, volumes and networks from `source` into `target`, skipping `composeProject`'s ephemeral default networks. */
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

import { readFile, access, constants } from "fs/promises";
import { join } from "path";
import { parseCompose } from "@/lib/docker/compose";

export type GitBuildContext = {
  gitUrl: string;
  gitBranch: string | null;
  hasBuildDirectives: boolean;
};

/** Git remote, branch and build directives for a compose project directory. Null when inaccessible or not a git repo. */
export async function detectGitBuildContext(
  workingDir: string,
  configFiles: string,
): Promise<GitBuildContext | null> {
  try {
    await access(workingDir, constants.R_OK);
  } catch {
    return null; // Directory not accessible (not mounted or doesn't exist)
  }

  // Absolute or relative.
  const composeFile = configFiles.startsWith("/")
    ? configFiles
    : join(workingDir, configFiles.split(",")[0] ?? "docker-compose.yml");

  let hasBuildDirectives = false;
  try {
    const content = await readFile(composeFile, "utf-8");
    const compose = parseCompose(content);
    hasBuildDirectives = Object.values(compose.services).some((svc) => svc.build);
  } catch {
    return null;
  }

  let gitUrl: string | null = null;
  let gitBranch: string | null = null;
  try {
    const { stdout: remoteUrl } = await execFileAsync(
      "git",
      ["-C", workingDir, "remote", "get-url", "origin"],
      { timeout: 5000 },
    );
    gitUrl = remoteUrl.trim();

    // SSH to HTTPS.
    if (gitUrl.startsWith("git@")) {
      gitUrl = gitUrl.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");
    }

    const { stdout: branch } = await execFileAsync(
      "git",
      ["-C", workingDir, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: 5000 },
    );
    gitBranch = branch.trim();
    if (gitBranch === "HEAD") gitBranch = null; // Detached HEAD
  } catch {
    return null;
  }

  if (!gitUrl) return null;

  return {
    gitUrl,
    gitBranch,
    hasBuildDirectives,
  };
}
