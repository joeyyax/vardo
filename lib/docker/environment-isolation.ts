// ---------------------------------------------------------------------------
// Compose transforms for a non-default environment.
//
// The repo's compose describes production: hand-written Traefik routers carry
// production hostnames and router names, and a fixed container_name belongs to
// the production container. A preview built from it must declare none of that,
// or Traefik merges its routers with production's and sends live traffic to it.
// ---------------------------------------------------------------------------

import type { ComposeFile, ComposeService } from "./compose-types";
import { TRAEFIK_LABEL_PREFIX } from "./compose-generate";
import { TRAEFIK_MANUAL_LABEL } from "./compose-inject";

const ROUTER_RULE = /^traefik\.http\.routers\.[^.]+\.rule$/;
const SERVICE_PORT = /^traefik\.http\.services\.[^.]+\.loadbalancer\.server\.port$/;

/** The service and port the compose's own Traefik labels route to, if any. */
export function handWrittenRoute(
  compose: ComposeFile,
): { service: string; port: number | null } | null {
  for (const [name, svc] of Object.entries(compose.services)) {
    const labels = svc.labels ?? {};
    if (!Object.keys(labels).some((k) => ROUTER_RULE.test(k))) continue;
    const portLabel = Object.entries(labels).find(([k]) => SERVICE_PORT.test(k))?.[1];
    const port = portLabel ? Number(portLabel) : NaN;
    return { service: name, port: Number.isInteger(port) && port > 0 ? port : null };
  }
  return null;
}

/**
 * Drop every Traefik label (keeping an explicit `traefik.enable: "false"`), the
 * self-routed marker, any fixed container_name and the compose `name:`.
 * Returns a new ComposeFile.
 */
export function isolateCompose(compose: ComposeFile): ComposeFile {
  const services: Record<string, ComposeService> = {};
  for (const [name, svc] of Object.entries(compose.services)) {
    const next: ComposeService = { ...svc };
    delete next.container_name;
    if (svc.labels) {
      const kept = Object.fromEntries(
        Object.entries(svc.labels).filter(
          ([k, v]) =>
            k !== TRAEFIK_MANUAL_LABEL &&
            (!k.startsWith(TRAEFIK_LABEL_PREFIX) || (k === "traefik.enable" && v === "false")),
        ),
      );
      next.labels = Object.keys(kept).length > 0 ? kept : undefined;
    }
    services[name] = next;
  }
  const isolated: ComposeFile = { ...compose, services };
  // A compose `name:` names production's shared project.
  delete isolated.name;
  return isolated;
}
