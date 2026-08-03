// ---------------------------------------------------------------------------
// Instance infrastructure
//
// Vardo's own stack and the shared core services. These are the platform every
// organization runs on, not any one tenant's apps, so their state is reported
// once at instance level rather than inside whichever org happens to hold the
// rows. Identity is by name, not the is_system_managed flag — the flag is
// backfilled onto compose children and a false one there must not unclassify
// a Vardo container.
// ---------------------------------------------------------------------------

import { isVardoStack } from "@/lib/api/system-managed";
import { isCoreServiceApp } from "./core-services";

/** True for Vardo's own containers and the shared core services. */
export function isInstanceInfraApp(name: string | null | undefined): boolean {
  if (!name) return false;
  return isVardoStack(name) || isCoreServiceApp(name);
}

/**
 * Whose containers these are, stamped as `vardo.scope` at deploy time. Promtail
 * reads it to keep the platform's own logs out of an organization's tenant.
 */
export type AppScope = "instance" | "app";

export function appScope(name: string | null | undefined): AppScope {
  return isInstanceInfraApp(name) ? "instance" : "app";
}

/**
 * True for anything Vardo pins itself. The flag catches the compose children of
 * a decomposed core service, whose names carry no instance-infra prefix.
 */
export function isVardoManagedApp(app: {
  name?: string | null;
  isSystemManaged?: boolean | null;
}): boolean {
  return app.isSystemManaged === true || isInstanceInfraApp(app.name);
}

/**
 * Health-probe service names to the app row each one runs as. Lets a probe
 * failure and the app's own conditions collapse into one subject instead of
 * reporting the same outage twice under two names.
 */
const PROBE_APP_NAMES: Record<string, string> = {
  PostgreSQL: "vardo-postgres",
  Redis: "vardo-redis",
  Traefik: "vardo-traefik",
  WireGuard: "vardo-wireguard",
  cAdvisor: "cadvisor",
  Loki: "loki",
  Promtail: "promtail",
};

/** App backing a health probe, or null for probes with no app row (Docker). */
export function probeAppName(serviceName: string): string | null {
  return PROBE_APP_NAMES[serviceName] ?? null;
}
