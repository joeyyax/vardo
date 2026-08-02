import { partitionBySlot } from "./slot-partition";
import type { ComposeFile } from "./compose-types";

/** A network the compose declares itself, rather than referencing one that exists. */
function isProjectScoped(config: unknown): boolean {
  return !(config && typeof config === "object" && (config as { external?: unknown }).external);
}

/**
 * Networks a shared service attaches to.
 *
 * Compose scopes a declared network to its project, so the shared and slot
 * projects would each create their own — and a network with a fixed subnet
 * fails outright with "pool overlaps with other one on this address space".
 * These have to become external, under one name both projects reference.
 */
export function sharedNetworks(compose: ComposeFile): Set<string> {
  const declared = Object.entries(compose.networks ?? {})
    .filter(([, config]) => isProjectScoped(config))
    .map(([name]) => name);
  if (declared.length === 0) return new Set();

  const { shared } = partitionBySlot(compose);
  if (Object.keys(shared).length === 0) return new Set();

  const declaredSet = new Set(declared);
  const used = new Set<string>();
  for (const service of Object.values(shared)) {
    for (const net of service.networks ?? []) {
      if (declaredSet.has(net)) used.add(net);
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
