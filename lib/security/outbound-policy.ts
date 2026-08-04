// ---------------------------------------------------------------------------
// Where the outbound allowlist comes from.
//
// Reaching an internal service on purpose is a legitimate thing to want on a
// homelab, so the block is escapable — but only by naming the host, never by
// turning the check off.
// ---------------------------------------------------------------------------

import { getSystemSettingRaw } from "@/lib/system-settings";
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
