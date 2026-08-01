// ---------------------------------------------------------------------------
// Standard rollback: resolving what a rollback deploy must actually deploy.
//
// A rollback is a normal blue-green deploy whose inputs come from a previous
// deployment's snapshots instead of the app's current row. This module loads
// that target and overlays it onto the in-memory app record before the pipeline
// runs. Anything that can't be resolved throws — deploying the branch tip under
// the label "rollback" is worse than failing.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";
import type { DeployApp } from "./deploy-context";
import { DeployBlockedError } from "./errors";

export type RollbackTarget = {
  targetDeploymentId: string;
  gitSha: string | null;
  config: ConfigSnapshot | null;
  /** Encrypted env blob from the target deployment. */
  envSnapshot: string | null;
  /** Whether to restore env vars as well as config. */
  includeEnvVars: boolean;
};

type TargetRow = {
  id: string;
  status: string;
  gitSha: string | null;
  envSnapshot: string | null;
  configSnapshot: ConfigSnapshot | null;
};

/** Injectable loader — the real implementation reads the deployments table. */
export type RollbackTargetLoader = (
  appId: string,
  deploymentId: string,
) => Promise<TargetRow | null>;

const defaultLoader: RollbackTargetLoader = async (appId, deploymentId) => {
  const row = await db.query.deployments.findFirst({
    where: and(eq(deployments.id, deploymentId), eq(deployments.appId, appId)),
    columns: {
      id: true,
      status: true,
      gitSha: true,
      envSnapshot: true,
      configSnapshot: true,
    },
  });
  return (row as TargetRow | undefined) ?? null;
};

export async function loadRollbackTarget(
  appId: string,
  deploymentId: string,
  includeEnvVars = false,
  load: RollbackTargetLoader = defaultLoader,
): Promise<RollbackTarget> {
  const row = await load(appId, deploymentId);
  if (!row) {
    throw new DeployBlockedError(`Rollback target deployment ${deploymentId} not found for this app`);
  }
  if (row.status !== "success") {
    throw new DeployBlockedError(
      `Rollback target deployment ${deploymentId} is "${row.status}" — only successful deployments can be rolled back to`,
    );
  }
  return {
    targetDeploymentId: row.id,
    gitSha: row.gitSha,
    config: row.configSnapshot ?? null,
    envSnapshot: row.envSnapshot,
    includeEnvVars,
  };
}

/**
 * Overlay the target's snapshot onto the app record the deploy pipeline reads,
 * and assert the target is deployable. Mutates `app`.
 */
export function applyRollbackTarget(
  app: DeployApp,
  target: RollbackTarget,
  log: (line: string) => void,
): void {
  const { config } = target;

  if (config) {
    app.cpuLimit = config.cpuLimit;
    app.memoryLimit = config.memoryLimit;
    app.gpuEnabled = config.gpuEnabled ?? false;
    app.containerPort = config.containerPort;
    app.imageName = config.imageName;
    app.gitBranch = config.gitBranch;
    app.composeFilePath = config.composeFilePath;
    app.rootDirectory = config.rootDirectory;
    app.restartPolicy = config.restartPolicy;
    app.autoTraefikLabels = config.autoTraefikLabels;
    app.backendProtocol = config.backendProtocol;
    if (config.composeContent != null) app.composeContent = config.composeContent;
    log(`[deploy] Rollback: using config from deployment ${target.targetDeploymentId}`);
  } else {
    log(`[deploy] Warning: rollback target ${target.targetDeploymentId} has no config snapshot`);
  }

  if (app.deployType === "image") {
    // A tag can be re-pointed; the digest is the only exact reference.
    const digest = config?.imageDigest;
    if (digest) {
      app.imageName = digest;
      log(`[deploy] Rollback: pinned image ${digest}`);
    } else if (config?.imageName) {
      log(`[deploy] Warning: no image digest recorded — pinning by tag ${config.imageName}`);
    } else {
      throw new DeployBlockedError(
        `Rollback target ${target.targetDeploymentId} has no recorded image — cannot roll back this image app`,
      );
    }
    return;
  }

  if (app.source === "git" && app.gitUrl) {
    if (!target.gitSha) {
      throw new DeployBlockedError(
        `Rollback target ${target.targetDeploymentId} has no recorded git SHA — cannot roll back to it`,
      );
    }
    return;
  }

  if (config?.composeContent == null) {
    log(
      `[deploy] Warning: rollback target ${target.targetDeploymentId} has no compose snapshot — ` +
      `deploying the app's current compose content`,
    );
  }
}

/** Env restore swaps the encrypted blob the pipeline decrypts. */
export function applyRollbackEnv(app: DeployApp, target: RollbackTarget, log: (line: string) => void): void {
  if (!target.includeEnvVars) return;
  if (!target.envSnapshot) {
    log(`[deploy] Warning: rollback target ${target.targetDeploymentId} has no env snapshot`);
    return;
  }
  app.envContent = target.envSnapshot;
  log(`[deploy] Rollback: restoring env vars from deployment ${target.targetDeploymentId}`);
}
