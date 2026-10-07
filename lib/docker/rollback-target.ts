// Resolves a rollback deploy's inputs from a previous deployment's snapshots.
// Anything unresolvable throws; never deploy the branch tip as a "rollback".

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

/** Injectable loader. */
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

/** Rewrite the single `image:` line to `ref`, or null unless the compose has exactly one image. */
export function pinComposeImage(composeContent: string, ref: string): string | null {
  const lines = composeContent.split("\n");
  const imageLines = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /^\s+image:\s*\S/.test(line));

  if (imageLines.length !== 1) return null;

  const { line, i } = imageLines[0];
  const indent = line.match(/^\s*/)?.[0] ?? "  ";
  lines[i] = `${indent}image: ${ref}`;
  return lines.join("\n");
}

/** Overlay the target's snapshot onto `app` and assert it's deployable. Mutates `app`. */
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
      // prepare-repo reads composeContent, not imageName, for image apps.
      if (app.composeContent) {
        const pinned = pinComposeImage(app.composeContent, digest);
        if (pinned) {
          app.composeContent = pinned;
        } else {
          log(`[deploy] Warning: compose has multiple services — rolling back by tag, not digest`);
        }
      }
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
