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

/** Project-scoped networks a shared service joins, implicit default included. These must become external. */
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

/** External name for a shared network, matching what the shared project would have created. */
export function sharedNetworkName(
  compose: ComposeFile,
  netName: string,
  fallbackPrefix: string,
): string {
  return `${compose.name ?? fallbackPrefix}_${netName}`;
}

/** Docker names for the shared networks as one compose project scopes them. */
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
