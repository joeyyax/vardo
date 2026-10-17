import type { ComposeFile } from "./compose-types";

export type HostPortHolder = { service: string; via: "ports" | "host-network" };

/**
 * Services that bind host ports, which blocks running two slots at once ("port is already allocated").
 * Every `ports` form counts, including bare `"80"`, and so does `network_mode: host`; `expose` doesn't.
 * Takes the slot's compose files in merge order; each service is named once.
 */
export function hostPortHolders(...files: (ComposeFile["services"] | undefined)[]): HostPortHolder[] {
  const holders = new Map<string, HostPortHolder>();
  for (const services of files) {
    for (const [service, svc] of Object.entries(services ?? {})) {
      if (svc?.network_mode === "host") holders.set(service, { service, via: "host-network" });
      else if (Array.isArray(svc?.ports) && svc.ports.length > 0 && !holders.has(service)) {
        holders.set(service, { service, via: "ports" });
      }
    }
  }
  return [...holders.values()];
}

/** Host-port holders among a slot's rotating services, counting ports Vardo's overlay publishes for them. */
export function slotHostPortHolders(
  slotted: ComposeFile["services"],
  overlay: ComposeFile["services"] | undefined,
): HostPortHolder[] {
  const rotating = Object.fromEntries(Object.entries(overlay ?? {}).filter(([name]) => name in slotted));
  return hostPortHolders(slotted, rotating);
}

/** "web (published ports), scrypted (host network)". */
export function describeHostPortHolders(holders: HostPortHolder[]): string {
  return holders
    .map((h) => `${h.service} (${h.via === "host-network" ? "host network" : "published ports"})`)
    .join(", ");
}
