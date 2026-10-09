// Creates the project network at deploy and keeps running containers on the right one.

import type { ComposeFile } from "./compose-types";
import { isSelfApp } from "./self-env";
import { COMPOSE_QUERY_TIMEOUT, VOLUME_CREATE_TIMEOUT } from "./constants";
import { dockerEnv } from "./docker-env";
import { execFileAsync } from "@/lib/utils/exec";
import {
  PROJECT_NETWORK_LABEL,
  attachableServices,
  isProjectNetwork,
  projectNetworkCollisions,
  projectNetworkName,
  type NetworkPeer,
} from "./project-network";

/** Runs `docker <args>`. Throws on a non-zero exit. */
export type DockerRun = (args: string[], timeout: number) => Promise<{ stdout: string }>;

const runDocker: DockerRun = async (args, timeout) => {
  const { stdout } = await execFileAsync("docker", args, { env: dockerEnv(), timeout });
  return { stdout: String(stdout) };
};

/** Vardo-managed containers on a network, in any state. Empty when the network doesn't exist. */
export async function networkPeers(network: string, run: DockerRun = runDocker): Promise<NetworkPeer[]> {
  const { stdout } = await run(
    [
      "ps", "-a", "--filter", `network=${network}`, "--filter", "label=vardo.project.id",
      "--format", '{{.Label "com.docker.compose.service"}}\t{{.Label "vardo.project.id"}}\t{{.Label "vardo.project"}}',
    ],
    COMPOSE_QUERY_TIMEOUT,
  );
  return stdout
    .split("\n")
    .map((line) => line.trim().split("\t"))
    .filter(([service, appId]) => service && appId)
    .map(([service, appId, appName]) => ({ service, appId, appName: appName || appId }));
}

/** Picks, checks and creates the app's project network. Null leaves the app off it. */
export async function prepareProjectNetwork(
  ctx: {
    app: { id: string; name: string; projectId: string | null };
    envName: string;
    compose: ComposeFile;
    log: (line: string) => void;
  },
  run: DockerRun = runDocker,
): Promise<string | null> {
  const { app, envName, compose, log } = ctx;
  if (!app.projectId || isSelfApp(app.name)) return null;
  const services = attachableServices(compose);
  if (services.length === 0) return null;

  const network = projectNetworkName(app.projectId, envName);
  let peers: NetworkPeer[];
  try {
    peers = await networkPeers(network, run);
  } catch (err) {
    log(`[deploy] project network ${network}: not attached — couldn't list its containers (${errText(err)})`);
    return null;
  }

  const collisions = projectNetworkCollisions(app.id, services, peers);
  if (collisions.length > 0) {
    const names = collisions.map((c) => `"${c.service}" (also in ${c.appName})`).join(", ");
    log(
      `[deploy] project network ${network}: not attached — ${names} would answer to the same name. ` +
        `Rename the service in one app to reach the project's other apps by name.`,
    );
    return null;
  }

  try {
    await run(
      [
        "network", "create",
        "--label", "vardo.managed=true",
        "--label", `${PROJECT_NETWORK_LABEL}=${app.projectId}`,
        "--label", `vardo.environment=${envName}`,
        network,
      ],
      VOLUME_CREATE_TIMEOUT,
    );
  } catch (err) {
    if (!/already exists/i.test(errText(err))) {
      log(`[deploy] project network ${network}: not attached — couldn't create it (${errText(err)})`);
      return null;
    }
  }
  return network;
}

/**
 * Put running containers on the app's project network and off any other project's.
 * Covers shared services a deploy doesn't recreate. Best-effort.
 */
export async function syncProjectNetwork(
  containers: { container: string; alias: string }[],
  network: string | null,
  run: DockerRun = runDocker,
): Promise<string[]> {
  const changed: string[] = [];
  for (const { container, alias } of containers) {
    let joined: string[];
    try {
      const { stdout } = await run(
        ["inspect", "--format", "{{json .NetworkSettings.Networks}}", container],
        COMPOSE_QUERY_TIMEOUT,
      );
      joined = Object.keys(JSON.parse(stdout.trim() || "{}") ?? {});
    } catch {
      continue;
    }
    for (const stale of joined.filter((n) => isProjectNetwork(n) && n !== network)) {
      await run(["network", "disconnect", stale, container], COMPOSE_QUERY_TIMEOUT).catch(() => {});
    }
    if (network && !joined.includes(network)) {
      try {
        await run(["network", "connect", "--alias", alias, network, container], COMPOSE_QUERY_TIMEOUT);
        changed.push(alias);
      } catch { /* gone or already attached */ }
    }
  }
  return changed;
}

function errText(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return err instanceof Error ? err.message : String(err);
}
