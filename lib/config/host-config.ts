import { readFile } from "fs/promises";
import { join } from "path";
import TOML from "@iarna/toml";

export type HostConfig = {
  project?: {
    name?: string;
    displayName?: string;
    description?: string;
    icon?: string;
    deployType?: string;
    port?: number;
    rootDirectory?: string;
  };
  deploy?: {
    autoDeploy?: boolean;
    branch?: string;
    restartPolicy?: string;
  };
  envVars?: { key: string; value: string }[];
  volumes?: { name: string; mountPath: string }[];
  domains?: { domain: string; ssl?: boolean }[];
  cron?: { name: string; schedule: string; command: string }[];
};

const CONFIG_FILES = ["host.toml", ".host.toml", "host.config.toml"];

/**
 * Read host.toml from a project directory.
 * Tries host.toml, .host.toml, host.config.toml in order.
 */
export async function readHostConfig(projectDir: string): Promise<HostConfig | null> {
  for (const filename of CONFIG_FILES) {
    try {
      const content = await readFile(join(projectDir, filename), "utf-8");
      return TOML.parse(content) as unknown as HostConfig;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Apply host.toml config to project settings during deploy.
 * Returns the fields that should be updated on the project.
 */
export function applyHostConfig(config: HostConfig): {
  containerPort?: number;
  autoDeploy?: boolean;
  rootDirectory?: string;
  restartPolicy?: string;
  envVars?: { key: string; value: string }[];
  persistentVolumes?: { name: string; mountPath: string }[];
} {
  const result: ReturnType<typeof applyHostConfig> = {};

  if (config.project?.port) result.containerPort = config.project.port;
  if (config.project?.rootDirectory) result.rootDirectory = config.project.rootDirectory;
  if (config.deploy?.autoDeploy !== undefined) result.autoDeploy = config.deploy.autoDeploy;
  if (config.deploy?.restartPolicy) result.restartPolicy = config.deploy.restartPolicy;
  if (config.envVars?.length) result.envVars = config.envVars;
  if (config.volumes?.length) {
    result.persistentVolumes = config.volumes.map((v) => ({
      name: v.name,
      mountPath: v.mountPath,
    }));
  }

  return result;
}
