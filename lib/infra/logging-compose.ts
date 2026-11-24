// Console settings written into the VictoriaLogs and log shipper compose at provisioning, so a change redeploys them.

import { collectorMode, DEFAULT_COLLECTOR_IMAGE } from "@/lib/collector/config";

type Env = Record<string, string | undefined>;

/** Compose variables the console fills in. Unset ones keep the template's default. */
const SETTINGS: Record<string, string[]> = {
  victorialogs: ["VARDO_VICTORIALOGS_RETENTION", "VARDO_VICTORIALOGS_MAX_DISK"],
  "log-shipper": ["VARDO_LOG_SHIPPER_IMAGE"],
};

/** The collector image, which ships logs in logs-only mode. */
export function logShipperImage(env: Env = process.env): string {
  const mode = collectorMode(env);
  return mode.kind === "provisioned" ? mode.image : DEFAULT_COLLECTOR_IMAGE;
}

/** `${NAME...}` references in a logging template replaced by the console's values. */
export function applyLoggingSettings(name: string, compose: string, env: Env = process.env): string {
  const values: Env = name === "log-shipper" ? { VARDO_LOG_SHIPPER_IMAGE: logShipperImage(env) } : env;
  let out = compose;
  for (const key of SETTINGS[name] ?? []) {
    const value = values[key]?.trim();
    if (!value) continue;
    out = out.replace(new RegExp(`\\$\\{${key}(?:[:?-][^}]*)?\\}`, "g"), value);
  }
  return out;
}
