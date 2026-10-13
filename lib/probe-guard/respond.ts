// The console's answer to a request Traefik's guard routers sent over: count, ban when due, then a short reply.

import { logger } from "@/lib/logger";
import { matchProbe } from "./rules";
import { hitRuleId } from "./labels";
import type { CustomBlock } from "./blocks";
import { HTML_RESPONSE_HEADERS, RESPONSE_HEADERS, errorPage, responseBody, wantsHtml } from "./responses";
import { normalizeIp, reachesThreshold } from "./ban-policy";
import { attributeBlock, type BanRef, type BlockMatch } from "./block-source";
import { banRef } from "./ban-ref";
import { CANARY_HEADERS, CANARY_QUERY_KEYS, findMarker, renderDecoyEnv } from "./canary";
import { decoyPath, type InstanceProbeGuard } from "./settings";
import { APP_HEADER, KEY_HEADER, type GuardKind } from "./traefik-file";
import type { BanOutcome, BanRequest } from "./bans";
import type { ProbeEventKind } from "@/lib/db/schema";

const log = logger.child("probe-guard");

const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PATH = 200;
/** Probe events kept per address per window. */
export const PROBE_EVENTS_PER_WINDOW = 50;

/** Whether a hit with this window count gets a probe event. Zero means the counter failed. */
export function recordsProbeEvent(hits: number): boolean {
  return hits > 0 && hits <= PROBE_EVENTS_PER_WINDOW;
}

export type GuardDeps = {
  hasKey: (value: string | null) => boolean;
  settings: () => Promise<InstanceProbeGuard>;
  clientIp: (headers: Headers) => Promise<string>;
  recordHit: (ip: string, appId: string | null, windowMs: number, ruleId: string) => Promise<number>;
  ban: (req: BanRequest) => Promise<BanOutcome>;
  recordEvent: (e: { kind: ProbeEventKind; ip: string; path?: string | null; canaryId?: string | null; appId?: string | null }) => Promise<void>;
  markerFor: (ip: string, appId: string | null) => Promise<{ id: string; marker: string }>;
  activeMarkers: () => Promise<{ id: string; marker: string }[]>;
  markUsed: (canaryId: string) => Promise<void>;
  appForHost: (host: string) => Promise<{ id: string } | null>;
  robotsFor: (settings: InstanceProbeGuard) => string;
  /** On the never-ban list: answered, never counted. */
  allowed?: (ip: string) => Promise<boolean>;
  /** The blocklist range an address is in, for forwarded clients the guard file's ClientIP matchers can't see. */
  blockedRange?: (ip: string) => Promise<string | null>;
  /** Active bans by address; the candidates let a cache refresh on a miss. */
  banLookup?: (ips: readonly string[]) => Promise<(ip: string) => BanRef | undefined>;
  /** Counts a blocked request. Must not throw or wait. */
  recordBlock?: (ip: string, match: BlockMatch) => void;
  /** The turn-away entries an app answers, to count a hit under the entry it tripped. */
  blocksFor?: (appId: string) => Promise<readonly CustomBlock[]>;
  /** Queues an exploit attempt for abuse reporting. */
  queueReport?: (ip: string) => Promise<unknown>;
};

/** A turned-away request: a small page for browsers, plain text for everything else. */
function deny(request: Request, status: number, opts: { banned?: boolean; until?: Date; ref?: string } = {}): Response {
  const head = request.method.toUpperCase() === "HEAD";
  if (wantsHtml(request.headers.get("accept"))) {
    return new Response(head ? null : errorPage(status, opts), { status, headers: HTML_RESPONSE_HEADERS });
  }
  return new Response(head ? null : responseBody(status), { status, headers: RESPONSE_HEADERS });
}

/** The original path Traefik's replacePath kept, without its query. */
export function originalPath(headers: Headers): string {
  const raw = headers.get("x-replaced-path") ?? "/";
  return raw.split("?")[0].slice(0, MAX_PATH) || "/";
}

/** Marker a request carries in a credential header or query value. Nothing it sent is kept. */
export function carriedMarker(headers: Headers, url: URL, markers: readonly string[]): string | null {
  for (const name of CANARY_HEADERS) {
    const found = findMarker(headers.get(name) ?? "", markers);
    if (found) return found;
  }
  const lowerKeys = new Set(CANARY_QUERY_KEYS.map((k) => k.toLowerCase()));
  for (const [k, v] of url.searchParams) {
    if (!lowerKeys.has(k.toLowerCase())) continue;
    const found = findMarker(v, markers);
    if (found) return found;
  }
  return null;
}

/** The peer Traefik saw: the last X-Forwarded-For hop, which its ClientIP matchers compare. */
function traefikPeer(headers: Headers): string | null {
  return headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || null;
}

/** Counts a banned-router request against the ban or range that explains it. Returns the ban, if one does. */
async function countBanned(ip: string, headers: Headers, deps: GuardDeps): Promise<BanRef | undefined> {
  const candidates = [...new Set([ip, traefikPeer(headers) ?? ""].map(normalizeIp).filter((c): c is string => !!c))];
  const banFor = (await deps.banLookup?.(candidates)) ?? (() => undefined);
  if (deps.recordBlock) {
    const ranges = new Map(await Promise.all(candidates.map(async (c) => [c, (await deps.blockedRange?.(c)) ?? null] as const)));
    deps.recordBlock(ip, attributeBlock(candidates, banFor, (c) => ranges.get(c) ?? null));
  }
  return candidates.map(banFor).find((ban) => ban !== undefined);
}

/** Handles one guarded request. Never throws and never says anything about the app. */
export async function handleGuardRequest(kind: GuardKind, request: Request, deps: GuardDeps): Promise<Response> {
  const method = request.method.toUpperCase();
  // Without Traefik's key this isn't a guarded request; answer like any missing page.
  if (!deps.hasKey(request.headers.get(KEY_HEADER))) return deny(request, 404);

  try {
    const settings = await deps.settings();
    const ip = await deps.clientIp(request.headers);
    const appHeader = request.headers.get(APP_HEADER);
    const appId = appHeader && APP_ID_RE.test(appHeader) ? appHeader : null;
    const path = originalPath(request.headers);

    if (kind === "banned") {
      const allowed = await deps.allowed?.(ip).catch(() => false);
      const ban = allowed ? undefined : await countBanned(ip, request.headers, deps).catch(() => undefined);
      // Blocklist bans have no row in the admin list, so a reference to one would lead nowhere.
      return deny(request, 403, { banned: true, until: ban?.expiresAt, ref: ban && !ban.blocklist ? banRef(ban.id, ban.createdAt) : undefined });
    }

    const allowed = kind !== "robots" && !!(await deps.allowed?.(ip).catch(() => false));
    const range = !allowed && kind !== "robots" ? await deps.blockedRange?.(ip).catch(() => null) : null;
    if (range) {
      deps.recordBlock?.(ip, { source: "spamhaus", range });
      return deny(request, 403, { banned: true });
    }

    if (kind === "robots") {
      return new Response(method === "HEAD" ? null : deps.robotsFor(settings), {
        status: 200,
        headers: { ...RESPONSE_HEADERS, "Cache-Control": "public, max-age=3600" },
      });
    }

    if (kind === "trap") {
      if (allowed) return deny(request, 404);
      await deps.recordEvent({ kind: "trap", ip, path, appId });
      await deps.ban({ ip, reason: "trap", appId, hits: 1 });
      if (path === decoyPath(settings)) {
        const { id, marker } = await deps.markerFor(ip, appId);
        await deps.recordEvent({ kind: "canary_fetch", ip, path, canaryId: id, appId });
        return new Response(method === "HEAD" ? null : renderDecoyEnv(marker), { status: 200, headers: RESPONSE_HEADERS });
      }
      return deny(request, 404);
    }

    if (kind === "canary") {
      if (allowed) return deny(request, 403);
      const markers = await deps.activeMarkers();
      const found = carriedMarker(request.headers, new URL(request.url), markers.map((m) => m.marker));
      const canary = found ? markers.find((m) => m.marker === found) : undefined;
      const app = appId ? { id: appId } : await deps.appForHost(request.headers.get("host") ?? "").catch(() => null);
      if (canary) {
        await deps.markUsed(canary.id);
        await deps.recordEvent({ kind: "canary_used", ip, canaryId: canary.id, appId: app?.id ?? null });
        await deps.ban({ ip, reason: "canary", appId: app?.id ?? null, hits: 1 });
      }
      return deny(request, 403);
    }

    const match = matchProbe(path);
    const status = match?.rule.status ?? 403;
    if (allowed) return deny(request, status);
    if (match?.rule.report === "exploit") void deps.queueReport?.(ip)?.catch(() => {});
    const blocks = !match && appId ? await deps.blocksFor?.(appId).catch(() => []) : undefined;
    const ruleId = match?.rule.id ?? hitRuleId(path, blocks);
    const hits = await deps.recordHit(ip, appId, settings.windowMinutes * 60_000, ruleId).catch(() => 0);
    if (recordsProbeEvent(hits)) await deps.recordEvent({ kind: "probe", ip, path, appId }).catch(() => {});
    if (reachesThreshold(hits, settings)) await deps.ban({ ip, reason: "threshold", appId, hits });
    return deny(request, status);
  } catch (err) {
    log.warn("Probe guard request failed:", err);
    return deny(request, 403);
  }
}
