// In-memory matchers for the responder: the allowlist, Spamhaus DROP ranges while that blocklist is on, and active bans.

import { cidrMatcher } from "@/lib/cloudflare-ips";
import { getAllowlist } from "./allowlist-store";
import { getAbuseSettings, getDropRanges } from "./abuse-store";
import { rangeFinder, type BanRef } from "./block-source";

const TTL_MS = 60_000;
/** Least time between ban reloads a miss triggers. */
const MISS_REFRESH_MS = 15_000;

type Lists = { at: number; allowed: (ip: string) => boolean; range: (ip: string) => string | null };
let cached: Lists | null = null;
let loading: Promise<Lists> | null = null;

async function load(): Promise<Lists> {
  const [allowlist, settings, drop] = await Promise.all([getAllowlist(), getAbuseSettings(), getDropRanges()]);
  const range = settings.blocklists.spamhaus.enabled && drop.ranges.length > 0 ? rangeFinder(drop.ranges) : () => null;
  return { at: Date.now(), allowed: cidrMatcher(allowlist.map((e) => e.value)), range };
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

/** The DROP range an address is in, or null. */
export async function blockedRangeFor(ip: string): Promise<string | null> {
  return (await lists()).range(ip);
}

type Bans = { at: number; refs: Map<string, BanRef> };
let bans: Bans | null = null;
let loadingBans: Promise<Bans> | null = null;

async function banIndex(force: boolean): Promise<Bans> {
  const age = bans ? Date.now() - bans.at : Infinity;
  if (bans && age < TTL_MS && !(force && age >= MISS_REFRESH_MS)) return bans;
  loadingBans ??= import("./bans")
    .then((m) => m.activeBanRefs())
    .then((refs) => ({ at: Date.now(), refs }))
    .finally(() => {
      loadingBans = null;
    });
  bans = await loadingBans;
  return bans;
}

/** Active bans by address. A miss reloads, at most every MISS_REFRESH_MS, so new bans are found. */
export async function banLookup(ips: readonly string[]): Promise<(ip: string) => BanRef | undefined> {
  let index = await banIndex(false);
  if (!ips.some((ip) => index.refs.has(ip))) index = await banIndex(true);
  return (ip) => index.refs.get(ip);
}

/** Drops the cache after an allowlist change in this process. */
export function resetClientLists(): void {
  cached = null;
  bans = null;
}
