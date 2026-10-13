// Creating, lifting and listing bans. Each change rewrites the guard file.

import { isIP } from "net";
import { and, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { apps, meshPeers, probeBans, type ProbeBanReason } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity";
import { trustedProxyRanges } from "@/lib/cloudflare-ips";
import { getServerIP } from "@/lib/server-ip";
import { logger } from "@/lib/logger";
import { REPEAT_LOOKBACK_MS, RETENTION_MS, banDurationMs, neverBanReason, normalizeIp, remoteBanExpiry, type NeverBanContext } from "./ban-policy";
import { getProbeGuardSettings } from "./instance";
import { syncGuardFile } from "./sync";
import { clearWindow } from "./hits";
import { PERMANENT_UNTIL } from "./permanent";
import { getAllowlist } from "./allowlist-store";
import { bansCovered } from "./allowlist";
import type { BanRef } from "./block-source";

const log = logger.child("probe-guard");

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    const host = value.includes("://") ? new URL(value).hostname : value.replace(/:\d+$/, "");
    const bare = host.replace(/^\[|\]$/g, "");
    return isIP(bare) ? bare : null;
  } catch {
    return null;
  }
}

/** This instance's addresses, trusted proxies, linked instances' addresses and the admin's allowlist. */
export async function neverBanContext(): Promise<NeverBanContext> {
  const ownIps = [await getServerIP().catch(() => ""), process.env.VARDO_SERVER_IP ?? ""].filter(Boolean);
  const peers = await db
    .select({ endpoint: meshPeers.endpoint, publicApiUrl: meshPeers.publicApiUrl })
    .from(meshPeers)
    .catch(() => []);
  const peerIps = peers.flatMap((p) => [hostOf(p.endpoint), hostOf(p.publicApiUrl)]).filter((ip): ip is string => !!ip);
  const allowlist = (await getAllowlist()).map((e) => e.value);
  return { ownIps, extraRanges: [...trustedProxyRanges(), ...peerIps], allowlist };
}

export type BanRow = typeof probeBans.$inferSelect;

export type BanRequest = {
  ip: string;
  reason: ProbeBanReason;
  appId?: string | null;
  hits?: number;
  /** A ban received from a linked instance. */
  origin?: { peerId: string; name: string; expiresAt: Date };
  /** An admin's ban: never reported. */
  manual?: boolean;
};

export type BanOutcome =
  | { status: "banned"; ban: BanRow }
  | { status: "already"; ban: BanRow }
  | { status: "refused"; reason: string };

export async function activeBanFor(ip: string, now = new Date()): Promise<BanRow | null> {
  const [row] = await db
    .select()
    .from(probeBans)
    .where(and(eq(probeBans.ip, ip), isNull(probeBans.liftedAt), gt(probeBans.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

/** Bans an address unless it's one Vardo never bans or it's already banned. */
export async function createBan(req: BanRequest, now = new Date()): Promise<BanOutcome> {
  const ip = normalizeIp(req.ip);
  if (!ip) return { status: "refused", reason: "not an IP address" };
  const never = neverBanReason(ip, await neverBanContext());
  if (never) return { status: "refused", reason: never };

  const settings = await getProbeGuardSettings();
  // One ban per address, even when two hits cross the threshold together.
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"probe-ban:" + ip}))`);
    const [existing] = await tx
      .select()
      .from(probeBans)
      .where(and(eq(probeBans.ip, ip), isNull(probeBans.liftedAt), gt(probeBans.expiresAt, now)))
      .limit(1);
    // A local ban replaces a blocklist one, so it renders first and can be reported.
    if (existing && existing.reason !== "blocklist") return { status: "already" as const, ban: existing };
    if (existing) await tx.delete(probeBans).where(eq(probeBans.id, existing.id));

    let expiresAt: Date;
    if (req.origin) {
      const at = remoteBanExpiry(req.origin.expiresAt, now, settings);
      if (!at) return { status: "refused" as const, reason: "already expired" };
      expiresAt = at;
    } else {
      const [prior] = await tx
        .select({ n: count() })
        .from(probeBans)
        .where(and(
          eq(probeBans.ip, ip),
          ne(probeBans.reason, "blocklist"),
          gt(probeBans.createdAt, new Date(now.getTime() - REPEAT_LOOKBACK_MS)),
        ));
      expiresAt = new Date(now.getTime() + banDurationMs(prior?.n ?? 0, settings));
    }

    const [inserted] = await tx
      .insert(probeBans)
      .values({
        id: nanoid(),
        ip,
        reason: req.origin ? "mesh" : req.reason,
        appId: req.appId ?? null,
        hits: req.hits ?? 0,
        originPeerId: req.origin?.peerId ?? null,
        originName: req.origin?.name ?? null,
        createdAt: now,
        expiresAt,
      })
      .returning();
    return { status: "banned" as const, ban: inserted };
  });
  if (outcome.status !== "banned") return outcome;
  const { ban } = outcome;
  const expiresAt = ban.expiresAt;

  await syncGuardFile().catch((err) => log.warn("Couldn't write the probe guard file:", err));
  await clearWindow(ip).catch(() => {});
  log.info(`Banned ${ip} until ${expiresAt.toISOString()} (${ban.reason})`);

  if (ban.appId) {
    const app = await db.query.apps.findFirst({ where: eq(apps.id, ban.appId), columns: { organizationId: true } });
    if (app) {
      await recordActivity({
        organizationId: app.organizationId,
        action: "security.probe_ban",
        appId: ban.appId,
        metadata: { ip, reason: ban.reason, hits: ban.hits, expiresAt: expiresAt.toISOString() },
      }).catch(() => {});
    }
  }

  if (!req.origin && settings.shareBans) {
    const { shareBan } = await import("./mesh-share");
    void shareBan(ban).catch((err) => log.warn("Couldn't share a ban with linked instances:", err));
  }

  if (!req.origin && !req.manual) {
    const { queueAbuseReport } = await import("./reporting/queue");
    void queueAbuseReport(ip).catch((err) => log.warn("Couldn't queue an abuse report:", err));
  }

  return { status: "banned", ban };
}

/** Lifts a ban now. Returns false when there was nothing active to lift. */
export async function liftBan(id: string, userId: string | null, scope?: { appId: string }): Promise<boolean> {
  const where = scope
    ? and(eq(probeBans.id, id), eq(probeBans.appId, scope.appId), isNull(probeBans.liftedAt))
    : and(eq(probeBans.id, id), isNull(probeBans.liftedAt));
  const [row] = await db.update(probeBans).set({ liftedAt: new Date(), liftedBy: userId }).where(where).returning();
  if (!row) return false;
  await syncGuardFile().catch((err) => log.warn("Couldn't write the probe guard file:", err));
  return true;
}

/** Makes an active ban permanent. Returns null when there was nothing active to change. Blocklist bans stay temporary. */
export async function makeBanPermanent(id: string, userId: string | null, scope?: { appId: string }, now = new Date()): Promise<BanRow | null> {
  const filters = [eq(probeBans.id, id), isNull(probeBans.liftedAt), gt(probeBans.expiresAt, now), ne(probeBans.reason, "blocklist")];
  if (scope) filters.push(eq(probeBans.appId, scope.appId));
  const [row] = await db.update(probeBans).set({ expiresAt: PERMANENT_UNTIL }).where(and(...filters)).returning();
  if (!row) return null;
  await syncGuardFile().catch((err) => log.warn("Couldn't write the probe guard file:", err));
  log.info(`Banned ${row.ip} permanently`);

  if (row.appId) {
    const app = await db.query.apps.findFirst({ where: eq(apps.id, row.appId), columns: { organizationId: true } });
    if (app) {
      await recordActivity({
        organizationId: app.organizationId,
        action: "security.probe_ban_permanent",
        appId: row.appId,
        userId: userId ?? undefined,
        metadata: { ip: row.ip, reason: row.reason },
      }).catch(() => {});
    }
  }

  // Linked instances cap it at their own maximum.
  if (!row.originPeerId && (await getProbeGuardSettings()).shareBans) {
    const { shareBan } = await import("./mesh-share");
    void shareBan(row).catch((err) => log.warn("Couldn't share a ban with linked instances:", err));
  }
  return row;
}

/** Bans an expired or lifted ban's address again, for the same reason. */
export async function banAgain(id: string, scope?: { appId: string }): Promise<BanOutcome | null> {
  const where = scope ? and(eq(probeBans.id, id), eq(probeBans.appId, scope.appId)) : eq(probeBans.id, id);
  const [row] = await db.select().from(probeBans).where(where).limit(1);
  if (!row || row.reason === "blocklist") return null;
  const reason = row.reason === "mesh" ? "threshold" : row.reason;
  return createBan({ ip: row.ip, reason, appId: row.appId, hits: row.hits, manual: true });
}

export type BanView = {
  id: string;
  ip: string;
  reason: ProbeBanReason;
  hits: number;
  originName: string | null;
  createdAt: Date;
  expiresAt: Date;
  appId: string | null;
  blockedCount: number;
  lastBlockedAt: Date | null;
};

/** Active bans, newest first, blocklist bans left out. Scoped to one app's bans when given. */
export async function listActiveBans(opts: { appId?: string; limit?: number } = {}, now = new Date()): Promise<BanView[]> {
  const filters = [isNull(probeBans.liftedAt), gt(probeBans.expiresAt, now), ne(probeBans.reason, "blocklist")];
  if (opts.appId) filters.push(eq(probeBans.appId, opts.appId));
  return db
    .select({
      id: probeBans.id,
      ip: probeBans.ip,
      reason: probeBans.reason,
      hits: probeBans.hits,
      originName: probeBans.originName,
      createdAt: probeBans.createdAt,
      expiresAt: probeBans.expiresAt,
      appId: probeBans.appId,
      blockedCount: probeBans.blockedCount,
      lastBlockedAt: probeBans.lastBlockedAt,
    })
    .from(probeBans)
    .where(and(...filters))
    .orderBy(desc(probeBans.createdAt))
    .limit(opts.limit ?? 200);
}

/** Local bans created since a time. */
export async function bansSince(since: Date, appId?: string): Promise<number> {
  const filters = [gt(probeBans.createdAt, since), ne(probeBans.reason, "blocklist")];
  if (appId) filters.push(eq(probeBans.appId, appId));
  const [row] = await db.select({ n: count() }).from(probeBans).where(and(...filters));
  return row?.n ?? 0;
}

/** Active permanent bans, for one app or all. */
export async function permanentBanCount(appId?: string): Promise<number> {
  const filters = [isNull(probeBans.liftedAt), gte(probeBans.expiresAt, PERMANENT_UNTIL)];
  if (appId) filters.push(eq(probeBans.appId, appId));
  const [row] = await db.select({ n: count() }).from(probeBans).where(and(...filters));
  return row?.n ?? 0;
}

/** Drops bans that expired before the retention window. Mirrors isPrunable, so active permanent bans stay. */
export async function pruneBans(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  await db
    .delete(probeBans)
    // Expired temporary bans, and any ban lifted that long ago, permanent ones included. Expired blocklist bans go at once.
    .where(or(
      and(lt(probeBans.expiresAt, cutoff), lt(probeBans.expiresAt, PERMANENT_UNTIL)),
      lt(probeBans.liftedAt, cutoff),
      and(eq(probeBans.reason, "blocklist"), isNull(probeBans.liftedAt), lt(probeBans.expiresAt, now)),
    ));
}

/** Lifts every active ban an allowlist value covers. */
export async function liftBansCovering(value: string, userId: string | null, now = new Date()): Promise<BanRow[]> {
  const active = await db
    .select()
    .from(probeBans)
    .where(and(isNull(probeBans.liftedAt), gt(probeBans.expiresAt, now)));
  const covered = bansCovered(active, value);
  if (covered.length === 0) return [];
  const lifted = await db
    .update(probeBans)
    .set({ liftedAt: now, liftedBy: userId })
    .where(and(inArray(probeBans.id, covered.map((b) => b.id)), isNull(probeBans.liftedAt)))
    .returning();
  await syncGuardFile().catch((err) => log.warn("Couldn't write the probe guard file:", err));
  return lifted;
}

export const BLOCKLIST_BAN_MS = 24 * 3_600_000;

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Replaces the blocklist bans with a fresh set for 24 hours. Skips never-ban addresses, addresses with
 * a local ban and ones an admin unbanned. Returns how many it added.
 */
export async function applyBlocklistBans(entries: readonly { ip: string; score: number }[], now = new Date()): Promise<number> {
  const ctx = await neverBanContext();
  const score = new Map<string, number>();
  for (const e of entries) {
    const ip = normalizeIp(e.ip);
    if (!ip || neverBanReason(ip, ctx)) continue;
    score.set(ip, Math.max(score.get(ip) ?? 0, Math.round(e.score)));
  }
  const expiresAt = new Date(now.getTime() + BLOCKLIST_BAN_MS);
  const added = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"probe-ban:blocklist"}))`);
    await tx.delete(probeBans).where(and(eq(probeBans.reason, "blocklist"), isNull(probeBans.liftedAt)));
    const ips = [...score.keys()];
    const taken = new Set<string>();
    for (const chunk of chunks(ips, 5000)) {
      const rows = await tx
        .select({ ip: probeBans.ip })
        .from(probeBans)
        .where(and(inArray(probeBans.ip, chunk), or(isNotNull(probeBans.liftedAt), gt(probeBans.expiresAt, now))));
      for (const r of rows) taken.add(r.ip);
    }
    const fresh = ips.filter((ip) => !taken.has(ip));
    for (const chunk of chunks(fresh, 1000)) {
      await tx.insert(probeBans).values(chunk.map((ip) => ({
        id: nanoid(),
        ip,
        reason: "blocklist" as const,
        hits: score.get(ip) ?? 0,
        createdAt: now,
        expiresAt,
      })));
    }
    return fresh.length;
  });
  await syncGuardFile().catch((err) => log.warn("Couldn't write the probe guard file:", err));
  return added;
}

/** Drops every blocklist ban an admin hasn't touched. */
export async function clearBlocklistBans(): Promise<number> {
  const rows = await db
    .delete(probeBans)
    .where(and(eq(probeBans.reason, "blocklist"), isNull(probeBans.liftedAt)))
    .returning({ id: probeBans.id });
  if (rows.length > 0) await syncGuardFile().catch((err) => log.warn("Couldn't write the probe guard file:", err));
  return rows.length;
}

/** Active blocklist bans. */
export async function blocklistBanCount(now = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(probeBans)
    .where(and(eq(probeBans.reason, "blocklist"), isNull(probeBans.liftedAt), gt(probeBans.expiresAt, now)));
  return row?.n ?? 0;
}

/** Active bans by address, for attributing blocked requests and telling a banned visitor when it ends. */
export async function activeBanRefs(now = new Date()): Promise<Map<string, BanRef>> {
  const rows = await db
    .select({ id: probeBans.id, ip: probeBans.ip, reason: probeBans.reason, expiresAt: probeBans.expiresAt })
    .from(probeBans)
    .where(and(isNull(probeBans.liftedAt), gt(probeBans.expiresAt, now)));
  const out = new Map<string, BanRef>();
  // A local ban outranks a blocklist one on the same address.
  for (const r of rows) {
    if (!out.has(r.ip) || r.reason !== "blocklist") out.set(r.ip, { id: r.id, blocklist: r.reason === "blocklist", expiresAt: r.expiresAt });
  }
  return out;
}

/** Adds flushed block counts to their bans. Bans deleted since are skipped. */
export async function addBanBlocks(rows: readonly { id: string; count: number; lastAt: Date }[]): Promise<void> {
  if (rows.length === 0) return;
  const values = sql.join(
    rows.map((r) => sql`(${r.id}, ${r.count}::integer, ${r.lastAt.toISOString()}::timestamptz)`),
    sql`, `,
  );
  await db.execute(sql`
    update ${probeBans} set
      blocked_count = ${probeBans.blockedCount} + v.n,
      last_blocked_at = greatest(${probeBans.lastBlockedAt}, v.at)
    from (values ${values}) as v(id, n, at)
    where ${probeBans.id} = v.id
  `);
}
