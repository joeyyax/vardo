import type { ComposeFile } from "./compose-types";

/**
 * Whether any service publishes a host port.
 *
 * Two slots can only run at once when nothing binds the host: a published port
 * is exclusive, so the second slot fails with "port is already allocated".
 * Traefik-routed services publish nothing and can overlap.
 *
 * Every form of `ports` publishes, including the bare `"80"` short form, which
 * takes an ephemeral host port. `expose` does not publish and is ignored.
 */
export function publishesHostPorts(services: ComposeFile["services"]): boolean {
  return Object.values(services ?? {}).some(
    (svc) => Array.isArray(svc?.ports) && svc.ports.length > 0,
  );
}
