// Builds the guard file from the database and writes it. Every writer renders the whole file from current rows.

import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains, probeBans, probeCanaries } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES, trustedProxyRanges } from "@/lib/cloudflare-ips";
import {
  MAX_RENDERED_BANS,
  MAX_RENDERED_BLOCKLIST,
  MAX_RENDERED_MARKERS,
  MAX_RENDERED_RANGES,
  writeGuardFile,
  type GuardApp,
  type GuardState,
} from "./traefik-file";
import { getAllowlist } from "./allowlist-store";
import { getAbuseSettings, getDropRanges } from "./abuse-store";
import { normalizeAppProbeGuard } from "./settings";
import { getProbeGuardSettings, guardKey } from "./instance";
import { SUGGESTED_RULES_ON } from "./rules";
import { getInstanceConfig } from "@/lib/system-settings";
import { banRenderOrder } from "./ban-policy";
import { blockableRanges } from "./blocklist/import";
import { PERMANENT_UNTIL } from "./permanent";
import type { CustomBlock } from "./blocks";

const log = logger.child("probe-guard");

const MARKER_TTL_MS = 30 * 24 * 3_600_000;

/** Guarded apps with their hosts. Children's domains count toward their parent. */
export async function loadGuardApps(): Promise<GuardApp[]> {
  const rows = await db
    .select({
      id: apps.id,
      parentAppId: apps.parentAppId,
      probeGuard: apps.probeGuard,
    })
    .from(apps);
  const top = rows.filter((r) => !r.parentAppId);
  const parentOf = new Map(rows.map((r) => [r.id, r.parentAppId ?? r.id]));
  const instance = await getProbeGuardSettings();

  const hostRows = await db
    .select({ appId: domains.appId, domain: domains.domain })
    .from(domains)
    .where(isNull(domains.pathPrefix));
  const hosts = new Map<string, string[]>();
  for (const h of hostRows) {
    const owner = parentOf.get(h.appId);
    if (owner) hosts.set(owner, [...(hosts.get(owner) ?? []), h.domain]);
  }

  return top.flatMap((app) => {
    const guard = normalizeAppProbeGuard(app.probeGuard);
    if (!guard.enabled) return [];
    return [{
      id: app.id,
      hosts: hosts.get(app.id) ?? [],
      exceptions: [...new Set([...instance.exceptions, ...guard.exceptions])],
      rules: guard.rules,
      blocks: [...instance.blocks, ...guard.blocks],
      robotsTxt: guard.robotsTxt,
    }];
  });
}

/** Turn-away entries each app answers: the instance's, then its own. */
export async function guardBlocks(appIds: readonly string[]): Promise<Map<string, CustomBlock[]>> {
  const ids = [...new Set(appIds)];
  if (ids.length === 0) return new Map();
  const [instance, rows] = await Promise.all([
    getProbeGuardSettings(),
    db.select({ id: apps.id, probeGuard: apps.probeGuard }).from(apps).where(inArray(apps.id, ids)),
  ]);
  return new Map(rows.map((r) => [r.id, [...instance.blocks, ...normalizeAppProbeGuard(r.probeGuard).blocks]]));
}

/** Permanent bans first, then the newest local ones, then blocklist bans by confidence. */
async function renderedBans(now: Date): Promise<{ ips: string[]; blocklist: Set<string>; local: Set<string> }> {
  const columns = { ip: probeBans.ip, expiresAt: probeBans.expiresAt, createdAt: probeBans.createdAt, reason: probeBans.reason, hits: probeBans.hits };
  const active = and(isNull(probeBans.liftedAt), gt(probeBans.expiresAt, now));
  const [local, blocklist] = await Promise.all([
    db
      .select(columns)
      .from(probeBans)
      .where(and(active, ne(probeBans.reason, "blocklist")))
      .orderBy(desc(sql`${probeBans.expiresAt} >= ${PERMANENT_UNTIL.toISOString()}::timestamptz`), desc(probeBans.createdAt))
      .limit(MAX_RENDERED_BANS),
    db
      .select(columns)
      .from(probeBans)
      .where(and(active, eq(probeBans.reason, "blocklist")))
      .orderBy(desc(probeBans.hits), desc(probeBans.createdAt))
      .limit(MAX_RENDERED_BLOCKLIST),
  ]);
  return {
    ips: banRenderOrder([...local, ...blocklist], MAX_RENDERED_BANS, MAX_RENDERED_BLOCKLIST),
    blocklist: new Set(blocklist.map((r) => r.ip)),
    local: new Set(local.map((r) => r.ip)),
  };
}

export async function activeBannedIps(now = new Date()): Promise<string[]> {
  return (await renderedBans(now)).ips;
}

/** Blocklist bans that make it into the guard file. */
export async function enforcedBlocklistBans(now = new Date()): Promise<number> {
  const { ips, blocklist, local } = await renderedBans(now);
  return ips.filter((ip) => blocklist.has(ip) && !local.has(ip)).length;
}

/** Spamhaus DROP ranges while that blocklist is on, less any overlapping the current allowlist. */
export async function activeBannedRanges(): Promise<string[]> {
  const [settings, drop, allowlist] = await Promise.all([getAbuseSettings(), getDropRanges(), getAllowlist()]);
  if (!settings.blocklists.spamhaus.enabled) return [];
  return blockableRanges(drop.ranges, { allowlist: allowlist.map((e) => e.value) }).slice(0, MAX_RENDERED_RANGES);
}

// Docker networks, where a cloudflared tunnel connects from.
const LOCAL_PEER_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];

/** Proxies whose Cf-Connecting-Ip an allowlist skip trusts. */
export function forwardingPeers(): string[] {
  return [...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES, ...trustedProxyRanges(), ...LOCAL_PEER_RANGES];
}

export async function activeMarkers(now = new Date()): Promise<string[]> {
  const rows = await db
    .select({ marker: probeCanaries.marker })
    .from(probeCanaries)
    .where(gt(probeCanaries.lastFetchedAt, new Date(now.getTime() - MARKER_TTL_MS)))
    .orderBy(desc(probeCanaries.lastFetchedAt))
    .limit(MAX_RENDERED_MARKERS);
  return rows.map((r) => r.marker);
}

export const CONSOLE_GUARD_ID = "vardo-console";

/** The console's own host, guarded for traps and probes. */
export async function consoleGuardApp(): Promise<GuardApp | null> {
  const domain = (await getInstanceConfig().catch(() => null))?.domain || process.env.VARDO_DOMAIN || "";
  if (!domain || domain === "localhost") return null;
  return { id: CONSOLE_GUARD_ID, hosts: [domain], exceptions: [], rules: SUGGESTED_RULES_ON, blocks: [], robotsTxt: false, console: true };
}

export async function loadGuardState(): Promise<GuardState | null> {
  const key = guardKey();
  if (!key) return null;
  const [settings, guardApps, consoleApp, bannedIps, bannedRanges, markers, allowlist] = await Promise.all([
    getProbeGuardSettings(),
    loadGuardApps(),
    consoleGuardApp(),
    activeBannedIps(),
    activeBannedRanges().catch(() => []),
    activeMarkers(),
    getAllowlist(),
  ]);
  return {
    key,
    apps: consoleApp ? [...guardApps, consoleApp] : guardApps,
    bannedIps,
    bannedRanges,
    skipClients: allowlist.filter((e) => e.skipGuard).map((e) => e.value),
    allowedClients: allowlist.map((e) => e.value),
    forwardingPeers: forwardingPeers(),
    trapPaths: settings.traps.enabled ? settings.traps.paths : [],
    markers,
    responderUrl: process.env.VARDO_PROBE_GUARD_URL || null,
  };
}

let chain: Promise<unknown> = Promise.resolve();

/** Rewrites the guard file from current rows. Calls in one process run in order. */
export function syncGuardFile(): Promise<"written" | "unchanged" | "skipped"> {
  const run = chain.then(async () => {
    const state = await loadGuardState();
    if (!state) return "skipped" as const;
    const outcome = await writeGuardFile(state);
    if (outcome === "written") log.info(`Probe guard file written: ${state.apps.length} apps, ${state.bannedIps.length} bans`);
    return outcome;
  });
  chain = run.catch(() => {});
  return run;
}

/** Fire-and-forget rewrite that logs instead of throwing. */
export function syncGuardFileSoon(): void {
  syncGuardFile().catch((err) => log.warn("Couldn't write the probe guard file:", err));
}

/** The guarded app a hostname belongs to. */
export async function appForHost(host: string): Promise<{ id: string; organizationId: string } | null> {
  const h = host.split(":")[0].toLowerCase();
  const rows = await db
    .select({ appId: domains.appId })
    .from(domains)
    .where(and(isNull(domains.pathPrefix), eq(domains.domain, h)))
    .limit(1);
  if (!rows[0]) return null;
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, rows[0].appId),
    columns: { id: true, organizationId: true, parentAppId: true },
  });
  if (!app) return null;
  return { id: app.parentAppId ?? app.id, organizationId: app.organizationId };
}
