// In-memory matchers for the responder: the allowlist and, while that blocklist is on, Spamhaus DROP ranges.

import { cidrMatcher } from "@/lib/cloudflare-ips";
import { getAllowlist } from "./allowlist-store";
import { getAbuseSettings, getDropRanges } from "./abuse-store";

const TTL_MS = 60_000;
type Lists = { at: number; allowed: (ip: string) => boolean; blocked: (ip: string) => boolean };
let cached: Lists | null = null;
let loading: Promise<Lists> | null = null;

async function load(): Promise<Lists> {
  const [allowlist, settings, drop] = await Promise.all([getAllowlist(), getAbuseSettings(), getDropRanges()]);
  const blocked = settings.blocklists.spamhaus.enabled && drop.ranges.length > 0 ? cidrMatcher(drop.ranges) : () => false;
  return { at: Date.now(), allowed: cidrMatcher(allowlist.map((e) => e.value)), blocked };
}

async function lists(): Promise<Lists> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached;
  loading ??= load().finally(() => {
    loading = null;
  });
  cached = await loading;
  return cached;
}

export async function isAllowlisted(ip: string): Promise<boolean> {
  return (await lists()).allowed(ip);
}

export async function inBlockedRange(ip: string): Promise<boolean> {
  return (await lists()).blocked(ip);
}

/** Drops the cache after an allowlist change in this process. */
export function resetClientLists(): void {
  cached = null;
}
