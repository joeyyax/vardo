// The network every app in a project joins per environment, so services resolve each other by service name.

import type { ComposeFile } from "./compose-types";
import { DEFAULT_NETWORK } from "./shared-networks";

export const PROJECT_NETWORK_PREFIX = "vardo-p-";

/** Label naming the project a project network belongs to. */
export const PROJECT_NETWORK_LABEL = "vardo.network.project";

/** Docker name of a project's network in one environment. */
export function projectNetworkName(projectId: string, envName: string): string {
  return `${PROJECT_NETWORK_PREFIX}${projectId}-${envName}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function isProjectNetwork(name: string): boolean {
  return name.startsWith(PROJECT_NETWORK_PREFIX);
}

/** Services that can join a user-defined network. */
export function attachableServices(compose: ComposeFile): string[] {
  return Object.entries(compose.services)
    .filter(([, svc]) => !svc.network_mode)
    .map(([name]) => name);
}

/** Attach every attachable service to the project network. An implicit default network is made explicit. */
export function injectProjectNetwork(compose: ComposeFile, networkName: string): ComposeFile {
  const services: ComposeFile["services"] = {};
  for (const [name, svc] of Object.entries(compose.services)) {
    if (svc.network_mode) {
      services[name] = svc;
      continue;
    }
    const current = svc.networks?.length ? svc.networks : [DEFAULT_NETWORK];
    services[name] = {
      ...svc,
      networks: current.includes(networkName) ? current : [...current, networkName],
    };
  }
  const attached = Object.values(services).some((svc) => svc.networks?.includes(networkName));
  if (!attached) return compose;
  return {
    ...compose,
    services,
    networks: { ...(compose.networks ?? {}), [networkName]: { external: true } },
  };
}

export type NetworkPeer = { service: string; appId: string; appName: string };

/** Peers from another app that answer to one of this app's service names. */
export function projectNetworkCollisions(
  appId: string,
  services: string[],
  peers: NetworkPeer[],
): NetworkPeer[] {
  const own = new Set(services);
  const seen = new Set<string>();
  return peers.filter((p) => {
    const key = `${p.appId}/${p.service}`;
    if (p.appId === appId || !own.has(p.service) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
