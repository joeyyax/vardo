// Outbound allowlist source. The block is escapable only by naming a host, never by turning it off.

import { getInstanceConfig, getSystemSettingRaw } from "@/lib/system-settings";
import type { OutboundPolicy } from "./ssrf";

/** Comma or newline separated hostnames. A leading "." matches subdomains. */
const ENV_KEY = "VARDO_OUTBOUND_ALLOWLIST";
const SETTING_KEY = "outbound_allowlist";

export function parseAllowlist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Env first so an operator can restore access without a working console. */
export async function getOutboundPolicy(): Promise<OutboundPolicy> {
  const fromEnv = parseAllowlist(process.env[ENV_KEY]);
  if (fromEnv.length > 0) return { allowlist: fromEnv };

  try {
    return { allowlist: parseAllowlist(await getSystemSettingRaw(SETTING_KEY)) };
  } catch {
    return { allowlist: [] };
  }
}

/** Probes of app domains also allow the instance's base domain, whose DNS the operator controls. */
export async function getDomainProbePolicy(): Promise<OutboundPolicy> {
  const { allowlist = [] } = await getOutboundPolicy();
  let baseDomain = process.env.VARDO_BASE_DOMAIN ?? "";
  try {
    baseDomain = (await getInstanceConfig()).baseDomain || baseDomain;
  } catch { /* env only */ }
  return baseDomain ? { allowlist: [...allowlist, `.${baseDomain}`] } : { allowlist };
}
