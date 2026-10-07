import type { ComposeFile } from "./compose-types";

/**
 * Whether any service publishes a host port, which blocks running two slots at once ("port is already allocated").
 * Every `ports` form publishes, including bare `"80"`; `expose` doesn't.
 */
export function publishesHostPorts(services: ComposeFile["services"]): boolean {
  return Object.values(services ?? {}).some(
    (svc) => Array.isArray(svc?.ports) && svc.ports.length > 0,
  );
}
