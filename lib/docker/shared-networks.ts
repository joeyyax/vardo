import { partitionBySlot } from "./slot-partition";
import type { ComposeFile, ComposeService } from "./compose-types";

/** Compose's implicit network, joined by any service that names none. */
export const DEFAULT_NETWORK = "default";

/** A network the compose declares itself, rather than referencing one that exists. */
function isProjectScoped(config: unknown): boolean {
  return !(config && typeof config === "object" && (config as { external?: unknown }).external);
}

/** Networks a service joins. An empty `networks:` is the implicit default. */
function serviceNetworks(service: ComposeService): string[] {
  if (service.network_mode) return [];
  return service.networks?.length ? service.networks : [DEFAULT_NETWORK];
}

/**
 * Networks a shared service attaches to.
 *
 * Compose scopes a declared network to its project, so the shared and slot
 * projects would each create their own — and a network with a fixed subnet
 * fails outright with "pool overlaps with other one on this address space".
 * These have to become external, under one name both projects reference.
 *
 * The implicit default counts. A compose file that declares no networks at all
 * still puts every service on it, so leaving it out strands a shared database
 * on a network nothing looking for `postgres:5432` can reach.
 */
export function sharedNetworks(compose: ComposeFile): Set<string> {
  const { shared } = partitionBySlot(compose);
  if (Object.keys(shared).length === 0) return new Set();

  const declared = (compose.networks ?? {}) as Record<string, unknown>;
  const claimable = (net: string) =>
    net in declared ? isProjectScoped(declared[net]) : net === DEFAULT_NETWORK;

  const used = new Set<string>();
  for (const service of Object.values(shared)) {
    for (const net of serviceNetworks(service)) {
      if (claimable(net)) used.add(net);
    }
  }
  return used;
}

/**
 * External name for a shared network — what the shared project would have
 * called it, so an already-running stack keeps the network it created.
 */
export function sharedNetworkName(
  compose: ComposeFile,
  netName: string,
  fallbackPrefix: string,
): string {
  return `${compose.name ?? fallbackPrefix}_${netName}`;
}

/**
 * Docker names for those same networks as a single compose project scopes them.
 *
 * A slot deployed before the externalization created them under its own project
 * prefix, and its compose file on disk still names them that way.
 */
export function projectScopedNetworkNames(
  compose: ComposeFile,
  projectName: string,
): string[] {
  return [...sharedNetworks(compose)].map((net) => `${projectName}_${net}`);
}

/** `docker network create` arguments carrying any subnet the compose pinned. */
export function networkCreateArgs(config: unknown, name: string): string[] {
  const args = ["network", "create"];
  const ipam = (config as { ipam?: { config?: Array<{ subnet?: string; gateway?: string }> } })?.ipam;
  for (const entry of ipam?.config ?? []) {
    if (entry.subnet) args.push("--subnet", entry.subnet);
    if (entry.gateway) args.push("--gateway", entry.gateway);
  }
  args.push(name);
  return args;
}
