// Creating, lifting and listing bans. Each change rewrites the guard file.

import { isIP } from "net";
import { and, count, desc, eq, gt, gte, isNull, lt, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { apps, meshPeers, probeBans, type ProbeBanReason } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity";
import { trustedProxyRanges } from "@/lib/cloudflare-ips";
import { getServerIP } from "@/lib/server-ip";
import { logger } from "@/lib/logger";
import { REPEAT_LOOKBACK_MS, banDurationMs, neverBanReason, normalizeIp, remoteBanExpiry, type NeverBanContext } from "./ban-policy";
import { getProbeGuardSettings } from "./instance";
import { syncGuardFile } from "./sync";
import { clearWindow } from "./hits";
import { PERMANENT_UNTIL } from "./permanent";

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

/** This instance's addresses, trusted proxies and linked instances' addresses. */
export async function neverBanContext(): Promise<NeverBanContext> {
  const ownIps = [await getServerIP().catch(() => ""), process.env.VARDO_SERVER_IP ?? ""].filter(Boolean);
  const peers = await db
    .select({ endpoint: meshPeers.endpoint, publicApiUrl: meshPeers.publicApiUrl })
    .from(meshPeers)
    .catch(() => []);
  const peerIps = peers.flatMap((p) => [hostOf(p.endpoint), hostOf(p.publicApiUrl)]).filter((ip): ip is string => !!ip);
  return { ownIps, extraRanges: [...trustedProxyRanges(), ...peerIps] };
}

export type BanRow = typeof probeBans.$inferSelect;

export type BanRequest = {
  ip: string;
  reason: ProbeBanReason;
  appId?: string | null;
  hits?: number;
  /** A ban received from a linked instance. */
  origin?: { peerId: string; name: string; expiresAt: Date };
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
    if (existing) return { status: "already" as const, ban: existing };

    let expiresAt: Date;
    if (req.origin) {
      const at = remoteBanExpiry(req.origin.expiresAt, now, settings);
      if (!at) return { status: "refused" as const, reason: "already expired" };
      expiresAt = at;
    } else {
      const [prior] = await tx
        .select({ n: count() })
        .from(probeBans)
        .where(and(eq(probeBans.ip, ip), gt(probeBans.createdAt, new Date(now.getTime() - REPEAT_LOOKBACK_MS))));
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

/** Makes an active ban permanent. Returns null when there was nothing active to change. */
export async function makeBanPermanent(id: string, userId: string | null, scope?: { appId: string }, now = new Date()): Promise<BanRow | null> {
  const filters = [eq(probeBans.id, id), isNull(probeBans.liftedAt), gt(probeBans.expiresAt, now)];
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

export type BanView = {
  id: string;
  ip: string;
  reason: ProbeBanReason;
  hits: number;
  originName: string | null;
  createdAt: Date;
  expiresAt: Date;
  appId: string | null;
};

/** Active bans, newest first. Scoped to one app's bans when given. */
export async function listActiveBans(opts: { appId?: string; limit?: number } = {}, now = new Date()): Promise<BanView[]> {
  const filters = [isNull(probeBans.liftedAt), gt(probeBans.expiresAt, now)];
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
    })
    .from(probeBans)
    .where(and(...filters))
    .orderBy(desc(probeBans.createdAt))
    .limit(opts.limit ?? 200);
}

/** Bans created since a time. */
export async function bansSince(since: Date, appId?: string): Promise<number> {
  const filters = [gt(probeBans.createdAt, since)];
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

/** Drops bans that expired before the repeat lookback. Mirrors isPrunable, so permanent bans stay. */
export async function pruneBans(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - REPEAT_LOOKBACK_MS);
  await db
    .delete(probeBans)
    // Expired temporary bans, and any ban lifted that long ago, permanent ones included.
    .where(or(
      and(lt(probeBans.expiresAt, cutoff), lt(probeBans.expiresAt, PERMANENT_UNTIL)),
      lt(probeBans.liftedAt, cutoff),
    ));
}
