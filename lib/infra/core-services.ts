// Core services: one row each in the Vardo system org, shared by every organization.

import type { FeatureFlag } from "@/lib/config/features";
import { shouldProvisionCollector } from "@/lib/collector/config";
import { logger } from "@/lib/logger";

const log = logger.child("core-services");

/** system_settings key holding the last provisioning outcome per service. */
export const CORE_SERVICES_STATUS_KEY = "core_services_status";

/** Why a service is instance-wide: "host-agent" reads the whole host; "app" separates orgs inside one instance. */
export type CoreServiceKind = "host-agent" | "app";

export type CoreServiceDef = {
  name: string;
  displayName: string;
  kind: CoreServiceKind;
  /** Provisioned only when this returns true. Unset means always, with the flag. */
  enabled?: () => boolean;
};

/** A feature flag and the core services it turns on, governing provisioning and every org's access. */
export type CoreServiceFeature = {
  flag: FeatureFlag;
  /** Template and app name of each service, in deploy order. */
  services: CoreServiceDef[];
  project: { name: string; displayName: string };
};

export const CORE_SERVICE_FEATURES: CoreServiceFeature[] = [
  {
    flag: "metrics",
    services: [
      // A collector given by VARDO_COLLECTOR_URL is the operator's to run.
      { name: "collector", displayName: "Collector", kind: "host-agent", enabled: () => shouldProvisionCollector() },
    ],
    project: { name: "metrics", displayName: "Metrics" },
  },
  {
    flag: "logging",
    services: [
      { name: "loki", displayName: "Loki", kind: "app" },
      { name: "promtail", displayName: "Promtail", kind: "host-agent" },
    ],
    project: { name: "logs", displayName: "Logs" },
  },
];

/** Every core service app name. */
export const CORE_SERVICE_NAMES: string[] = CORE_SERVICE_FEATURES.flatMap((f) =>
  f.services.map((s) => s.name),
);

/** Core services Vardo no longer runs. A leftover row stays instance infrastructure until it's removed. */
export const RETIRED_CORE_SERVICE_NAMES: string[] = ["cadvisor"];

/** True when this app name belongs to an instance-level core service, retired ones included. */
export function isCoreServiceApp(name: string): boolean {
  return CORE_SERVICE_NAMES.includes(name) || RETIRED_CORE_SERVICE_NAMES.includes(name);
}

/** Flags that provision a shared, instance-level service. */
export const CORE_SERVICE_FLAGS: FeatureFlag[] = CORE_SERVICE_FEATURES.map((f) => f.flag);

/** True when this flag turns on a shared instance-level service. */
export function isCoreServiceFlag(flag: FeatureFlag): boolean {
  return CORE_SERVICE_FLAGS.includes(flag);
}

// Status. Startup provisioning can't raise a toast, so every outcome is recorded for the admin page.

export type CoreServiceState =
  /** Flag is off. */
  | "off"
  /** App row exists and its first deploy was requested or already done. */
  | "provisioned"
  /** Another app already owns the name instance-wide, so it can't be created. */
  | "conflict"
  /** The built-in template is missing from the templates directory. */
  | "missing-template"
  /** The app exists but its deploy failed. */
  | "failed"
  /** A retired service still installed, kept until it's safe to remove. */
  | "retiring";

export type CoreServiceStatus = {
  name: string;
  displayName: string;
  flag: FeatureFlag;
  state: CoreServiceState;
  /** Organization holding the app row. */
  organizationId: string | null;
  appId: string | null;
  /** Operator-facing explanation. Always set when the state isn't "provisioned". */
  detail: string | null;
  checkedAt: string;
};

type StatusRecord = Record<string, CoreServiceStatus>;

/** Last recorded outcome per service, keyed by app name. */
export async function readCoreServiceStatus(): Promise<StatusRecord> {
  const { getSystemSettingRaw } = await import("@/lib/system-settings");
  const raw = await getSystemSettingRaw(CORE_SERVICES_STATUS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StatusRecord) : {};
  } catch {
    return {};
  }
}

/** Merge outcomes into the stored record. Best-effort — never throws. */
export async function recordCoreServiceStatus(
  entries: Omit<CoreServiceStatus, "checkedAt">[],
): Promise<void> {
  if (entries.length === 0) return;
  try {
    const { setSystemSetting } = await import("@/lib/system-settings");
    const current = await readCoreServiceStatus();
    const checkedAt = new Date().toISOString();
    for (const entry of entries) current[entry.name] = { ...entry, checkedAt };
    await setSystemSetting(CORE_SERVICES_STATUS_KEY, JSON.stringify(current));
  } catch (err) {
    log.error("Failed to record core service status:", err);
  }
}

/** Drop a service from the stored record. Best-effort — never throws. */
export async function removeCoreServiceStatus(name: string): Promise<void> {
  try {
    const current = await readCoreServiceStatus();
    if (!(name in current)) return;
    delete current[name];
    const { setSystemSetting } = await import("@/lib/system-settings");
    await setSystemSetting(CORE_SERVICES_STATUS_KEY, JSON.stringify(current));
  } catch (err) {
    log.error("Failed to update core service status:", err);
  }
}

/** Whether a service of an enabled flag is provisioned on this install. */
export function isCoreServiceEnabled(service: CoreServiceDef): boolean {
  return service.enabled ? service.enabled() : true;
}

/** Every core service with its last recorded outcome, then retired ones still recorded. Never-provisioned services report "off". */
export function summarizeCoreServices(
  stored: StatusRecord,
  flagState: Record<string, boolean>,
): CoreServiceStatus[] {
  const retired = RETIRED_CORE_SERVICE_NAMES.flatMap((name) => {
    const status = stored[name];
    if (!status) return [];
    return [{ ...status, state: "retiring" as const, detail: status.state === "retiring" ? status.detail : null }];
  });
  return [...currentCoreServices(stored, flagState), ...retired];
}

function currentCoreServices(stored: StatusRecord, flagState: Record<string, boolean>): CoreServiceStatus[] {
  return CORE_SERVICE_FEATURES.flatMap((feature) =>
    feature.services.map((service) => {
      const enabled = (flagState[feature.flag] ?? false) && isCoreServiceEnabled(service);
      const status = stored[service.name];
      if (!enabled) {
        return {
          name: service.name,
          displayName: service.displayName,
          flag: feature.flag,
          state: "off" as const,
          organizationId: null,
          appId: null,
          detail: null,
          checkedAt: status?.checkedAt ?? new Date(0).toISOString(),
        };
      }
      return (
        status ?? {
          name: service.name,
          displayName: service.displayName,
          flag: feature.flag,
          state: "failed" as const,
          organizationId: null,
          appId: null,
          detail: "Turned on but never provisioned. Restart Vardo or toggle the flag to retry.",
          checkedAt: new Date(0).toISOString(),
        }
      );
    }),
  );
}
