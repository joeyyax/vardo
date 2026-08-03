// ---------------------------------------------------------------------------
// Core services
//
// One row each, in the Vardo system org, shared by every organization. Two
// different reasons land them here:
//
//   host-agent — cAdvisor and Promtail read the whole host (privileged, /rootfs,
//     the Docker socket), so a second copy duplicates every sample and log line.
//     Singleton is a property of what they do.
//   app — Loki and GlitchTip are ordinary stacks that receive pushes. One
//     instance is the current limit, not a property: both are addressed by a
//     fixed DNS alias that a second instance would collide with. Per-org
//     instances need app-name namespacing that does not exist yet.
// ---------------------------------------------------------------------------

import type { FeatureFlag } from "@/lib/config/features";
import { logger } from "@/lib/logger";

const log = logger.child("core-services");

/** system_settings key holding the last provisioning outcome per service. */
export const CORE_SERVICES_STATUS_KEY = "core_services_status";

/**
 * A feature flag and the core services it turns on. The flag governs both
 * provisioning the shared service and every org's access to it — with one
 * instance of each service there is nothing to separate.
 */
/**
 * Why a service is instance-wide: "host-agent" reads the whole host and a
 * second copy would duplicate its data; "app" is an ordinary stack that is
 * single only until aliases are namespaced per instance.
 */
export type CoreServiceKind = "host-agent" | "app";

export type CoreServiceFeature = {
  flag: FeatureFlag;
  /** Template and app name of each service, in deploy order. */
  services: { name: string; displayName: string; kind: CoreServiceKind }[];
  project: { name: string; displayName: string };
  /** Per-template app settings, e.g. Traefik labels for user-facing services. */
  appOverrides?: Partial<{ autoTraefikLabels: boolean }>;
};

export const CORE_SERVICE_FEATURES: CoreServiceFeature[] = [
  {
    flag: "metrics",
    services: [{ name: "cadvisor", displayName: "cAdvisor", kind: "host-agent" }],
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
  {
    flag: "error-tracking",
    services: [{ name: "glitchtip", displayName: "GlitchTip", kind: "app" }],
    project: { name: "error-tracking", displayName: "Error Tracking" },
    appOverrides: { autoTraefikLabels: true },
  },
];

/** Every core service app name. */
export const CORE_SERVICE_NAMES: string[] = CORE_SERVICE_FEATURES.flatMap((f) =>
  f.services.map((s) => s.name),
);

/** True when this app name belongs to an instance-level core service. */
export function isCoreServiceApp(name: string): boolean {
  return CORE_SERVICE_NAMES.includes(name);
}

/** Flags that provision a shared, instance-level service rather than a per-org one. */
export const CORE_SERVICE_FLAGS: FeatureFlag[] = CORE_SERVICE_FEATURES.map((f) => f.flag);

/** True when this flag turns on a shared instance-level service. */
export function isCoreServiceFlag(flag: FeatureFlag): boolean {
  return CORE_SERVICE_FLAGS.includes(flag);
}

// ---------------------------------------------------------------------------
// Status
//
// Startup provisioning can't raise a toast, so every outcome is recorded here
// for the admin Core services page to read. Silence is not a success signal.
// ---------------------------------------------------------------------------

export type CoreServiceState =
  /** Flag is off — nothing provisioned, nothing expected. */
  | "off"
  /** App row exists and its first deploy was requested or already done. */
  | "provisioned"
  /** Another app already owns the name instance-wide, so it can't be created. */
  | "conflict"
  /** The built-in template is missing from the templates directory. */
  | "missing-template"
  /** The app exists but its deploy failed. */
  | "failed";

export type CoreServiceStatus = {
  name: string;
  displayName: string;
  flag: FeatureFlag;
  state: CoreServiceState;
  /** Organization holding the app row — the Vardo system org on a clean install. */
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

/**
 * Every core service with its last recorded outcome, in declaration order.
 * Services never provisioned report as "off" with no detail.
 */
export function summarizeCoreServices(
  stored: StatusRecord,
  flagState: Record<string, boolean>,
): CoreServiceStatus[] {
  return CORE_SERVICE_FEATURES.flatMap((feature) =>
    feature.services.map((service) => {
      const enabled = flagState[feature.flag] ?? false;
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

// A privileged deep link into the full GlitchTip suite would attach to the
// glitchtip entry here; it needs an agreed auth model before it can be built.
