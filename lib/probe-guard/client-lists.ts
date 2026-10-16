// In-memory matchers for the responder: the allowlist, Spamhaus DROP ranges while that blocklist is on, and active bans.

import { cidrMatcher } from "@/lib/cloudflare-ips";
import { getAllowlist } from "./allowlist-store";
import { getAbuseSettings, getDropRanges } from "./abuse-store";
import { rangeFinder, type BanRef } from "./block-source";
import { neverBanCheck } from "./ban-policy";
import { blockableRanges } from "./blocklist/import";

const TTL_MS = 60_000;
/** Least time between ban reloads a miss triggers. */
const MISS_REFRESH_MS = 15_000;

type Lists = { at: number; allowed: (ip: string) => boolean; range: (ip: string) => string | null };
let cached: Lists | null = null;
let loading: Promise<Lists> | null = null;

async function load(): Promise<Lists> {
  const [allowlist, settings, drop] = await Promise.all([getAllowlist(), getAbuseSettings(), getDropRanges()]);
  const values = allowlist.map((e) => e.value);
  // Same ranges the guard file renders, so a range overlapping the allowlist blocks nobody.
  const ranges = settings.blocklists.spamhaus.enabled ? blockableRanges(drop.ranges, { allowlist: values }) : [];
  return { at: Date.now(), allowed: cidrMatcher(values), range: ranges.length > 0 ? rangeFinder(ranges) : () => null };
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

type Exempt = { at: number; check: (ip: string) => boolean };
let exempt: Exempt | null = null;
let loadingExempt: Promise<Exempt> | null = null;

/** Matches the addresses bans skip: private ranges, Cloudflare, this instance, trusted proxies, linked instances and the allowlist. */
export async function exemptCheck(): Promise<(ip: string) => boolean> {
  if (!exempt || Date.now() - exempt.at >= TTL_MS) {
    loadingExempt ??= import("./bans")
      .then((m) => m.neverBanContext())
      .then((ctx) => ({ at: Date.now(), check: neverBanCheck(ctx) }))
      .finally(() => {
        loadingExempt = null;
      });
    exempt = await loadingExempt;
  }
  return exempt.check;
}

/** Whether an address is one bans skip, so its requests aren't counted either. */
export async function isExempt(ip: string): Promise<boolean> {
  return (await exemptCheck())(ip);
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
  exempt = null;
}
