import type { ComposeFile } from "./compose-types";

export type HostPortHolder = { service: string; via: "ports" | "host-network" };

/**
 * Services that bind host ports, which blocks running two slots at once ("port is already allocated").
 * Every `ports` form counts, including bare `"80"`, and so does `network_mode: host`; `expose` doesn't.
 */
export function hostPortHolders(services: ComposeFile["services"] | undefined): HostPortHolder[] {
  const holders: HostPortHolder[] = [];
  for (const [service, svc] of Object.entries(services ?? {})) {
    if (svc?.network_mode === "host") holders.push({ service, via: "host-network" });
    else if (Array.isArray(svc?.ports) && svc.ports.length > 0) holders.push({ service, via: "ports" });
  }
  return holders;
}

/** "web (published ports), scrypted (host network)". */
export function describeHostPortHolders(holders: HostPortHolder[]): string {
  return holders
    .map((h) => `${h.service} (${h.via === "host-network" ? "host network" : "published ports"})`)
    .join(", ");
}
