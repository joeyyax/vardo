// The console's answer to a request Traefik's guard routers sent over: count, ban when due, then a short plain-text reply.

import { logger } from "@/lib/logger";
import { matchProbe } from "./rules";
import { RESPONSE_HEADERS, responseBody, type ResponseKind } from "./responses";
import { reachesThreshold } from "./ban-policy";
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
  recordHit: (ip: string, appId: string | null, windowMs: number) => Promise<number>;
  ban: (req: BanRequest) => Promise<BanOutcome>;
  recordEvent: (e: { kind: ProbeEventKind; ip: string; path?: string | null; canaryId?: string | null; appId?: string | null }) => Promise<void>;
  markerFor: (ip: string, appId: string | null) => Promise<{ id: string; marker: string }>;
  activeMarkers: () => Promise<{ id: string; marker: string }[]>;
  markUsed: (canaryId: string) => Promise<void>;
  appForHost: (host: string) => Promise<{ id: string } | null>;
  robotsFor: (settings: InstanceProbeGuard) => string;
  /** On the never-ban list: answered, never counted. */
  allowed?: (ip: string) => Promise<boolean>;
  /** In a blocklist range, for forwarded clients the guard file's ClientIP matchers can't see. */
  blockedRange?: (ip: string) => Promise<boolean>;
  /** Queues an exploit attempt for abuse reporting. */
  queueReport?: (ip: string) => Promise<unknown>;
};

function reply(status: number, body: string, method: string): Response {
  return new Response(method === "HEAD" ? null : body, { status, headers: RESPONSE_HEADERS });
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

/** Handles one guarded request. Never throws and never says anything about the app. */
export async function handleGuardRequest(kind: GuardKind, request: Request, deps: GuardDeps): Promise<Response> {
  const method = request.method.toUpperCase();
  // Without Traefik's key this isn't a guarded request; answer like any missing page.
  if (!deps.hasKey(request.headers.get(KEY_HEADER))) return reply(404, "Not Found\n", method);

  try {
    const settings = await deps.settings();
    const humor = settings.humor;
    const ip = await deps.clientIp(request.headers);
    const appHeader = request.headers.get(APP_HEADER);
    const appId = appHeader && APP_ID_RE.test(appHeader) ? appHeader : null;
    const path = originalPath(request.headers);

    if (kind === "banned") return reply(403, responseBody("banned", 403, humor), method);

    const allowed = kind !== "robots" && !!(await deps.allowed?.(ip).catch(() => false));
    if (!allowed && kind !== "robots" && (await deps.blockedRange?.(ip).catch(() => false))) {
      return reply(403, responseBody("banned", 403, humor), method);
    }

    if (kind === "robots") {
      return new Response(method === "HEAD" ? null : deps.robotsFor(settings), {
        status: 200,
        headers: { ...RESPONSE_HEADERS, "Cache-Control": "public, max-age=3600" },
      });
    }

    if (kind === "trap") {
      if (allowed) return reply(404, responseBody("trap", 404, humor), method);
      await deps.recordEvent({ kind: "trap", ip, path, appId });
      await deps.ban({ ip, reason: "trap", appId, hits: 1 });
      if (path === decoyPath(settings)) {
        const { id, marker } = await deps.markerFor(ip, appId);
        await deps.recordEvent({ kind: "canary_fetch", ip, path, canaryId: id, appId });
        return new Response(method === "HEAD" ? null : renderDecoyEnv(marker), { status: 200, headers: RESPONSE_HEADERS });
      }
      return reply(404, responseBody("trap", 404, humor), method);
    }

    if (kind === "canary") {
      if (allowed) return reply(403, responseBody("canary", 403, humor), method);
      const markers = await deps.activeMarkers();
      const found = carriedMarker(request.headers, new URL(request.url), markers.map((m) => m.marker));
      const canary = found ? markers.find((m) => m.marker === found) : undefined;
      const app = appId ? { id: appId } : await deps.appForHost(request.headers.get("host") ?? "").catch(() => null);
      if (canary) {
        await deps.markUsed(canary.id);
        await deps.recordEvent({ kind: "canary_used", ip, canaryId: canary.id, appId: app?.id ?? null });
        await deps.ban({ ip, reason: "canary", appId: app?.id ?? null, hits: 1 });
      }
      return reply(403, responseBody("canary", 403, humor), method);
    }

    const match = matchProbe(path);
    const status = match?.rule.status ?? 403;
    const category: ResponseKind = match?.rule.category ?? "framework";
    if (allowed) return reply(status, responseBody(category, status, humor), method);
    if (match?.rule.report === "exploit") void deps.queueReport?.(ip)?.catch(() => {});
    const hits = await deps.recordHit(ip, appId, settings.windowMinutes * 60_000).catch(() => 0);
    if (recordsProbeEvent(hits)) await deps.recordEvent({ kind: "probe", ip, path, appId }).catch(() => {});
    if (reachesThreshold(hits, settings)) await deps.ban({ ip, reason: "threshold", appId, hits });
    return reply(status, responseBody(category, status, humor), method);
  } catch (err) {
    log.warn("Probe guard request failed:", err);
    return reply(403, "Forbidden\n", method);
  }
}
