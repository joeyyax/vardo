// Instance infrastructure: Vardo's stack and core services, reported at instance level.
// Identity is by name; the is_system_managed flag is backfilled onto children and can be wrong.

import { isVardoStack } from "@/lib/api/system-managed";
import { isCoreServiceApp } from "./core-services";

/** True for Vardo's own containers and the shared core services. */
export function isInstanceInfraApp(name: string | null | undefined): boolean {
  if (!name) return false;
  return isVardoStack(name) || isCoreServiceApp(name);
}

/** Scope stamped as `vardo.scope` at deploy time. Promtail uses it to keep platform logs out of org tenants. */
export type AppScope = "instance" | "app";

export function appScope(name: string | null | undefined): AppScope {
  return isInstanceInfraApp(name) ? "instance" : "app";
}

/** True for anything Vardo pins itself, including children of a decomposed core service. */
export function isVardoManagedApp(app: {
  name?: string | null;
  isSystemManaged?: boolean | null;
}): boolean {
  return app.isSystemManaged === true || isInstanceInfraApp(app.name);
}

/** Health-probe service names to their app rows, so a probe failure and the app's conditions are one subject. */
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
