import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { clientIpFor } from "@/lib/security/client-ip";
import { GUARD_KINDS, type GuardKind } from "@/lib/probe-guard/traefik-file";
import { handleGuardRequest, type GuardDeps } from "@/lib/probe-guard/respond";
import { getProbeGuardSettings, hasGuardKey } from "@/lib/probe-guard/instance";
import { recordHit } from "@/lib/probe-guard/hits";
import { createBan } from "@/lib/probe-guard/bans";
import { activeCanaries, markUsed, markerFor, recordEvent } from "@/lib/probe-guard/events";
import { appForHost, guardBlocks } from "@/lib/probe-guard/sync";
import type { CustomBlock } from "@/lib/probe-guard/blocks";
import { renderAppRobots } from "@/lib/probe-guard/robots";
import { banLookup, blockedRangeFor, isExempt } from "@/lib/probe-guard/client-lists";
import { recordBlock } from "@/lib/probe-guard/blocked";
import { queueAbuseReport } from "@/lib/probe-guard/reporting/queue";

export const dynamic = "force-dynamic";

// Traefik sends probes, traps, canaries and banned clients here from the guard file. Its key header gates every answer.

const known = new Map<string, { ok: boolean; at: number }>();
const KNOWN_TTL_MS = 60_000;

/** An app id from the header that still exists, so records never point at a deleted app. */
async function existingApp(id: string | null): Promise<string | null> {
  if (!id) return null;
  const hit = known.get(id);
  if (hit && Date.now() - hit.at < KNOWN_TTL_MS) return hit.ok ? id : null;
  const row = await db.query.apps.findFirst({ where: eq(apps.id, id), columns: { id: true } }).catch(() => null);
  if (known.size > 1000) known.clear();
  known.set(id, { ok: !!row, at: Date.now() });
  return row ? id : null;
}

const blockCache = new Map<string, { blocks: CustomBlock[]; at: number }>();

/** An app's turn-away entries, cached like the app check. */
async function blocksFor(id: string): Promise<CustomBlock[]> {
  const hit = blockCache.get(id);
  if (hit && Date.now() - hit.at < KNOWN_TTL_MS) return hit.blocks;
  const blocks = (await guardBlocks([id])).get(id) ?? [];
  if (blockCache.size > 1000) blockCache.clear();
  blockCache.set(id, { blocks, at: Date.now() });
  return blocks;
}

const deps: GuardDeps = {
  hasKey: (value) => hasGuardKey(value),
  settings: getProbeGuardSettings,
  clientIp: clientIpFor,
  recordHit: async (ip, appId, windowMs, ruleId) => recordHit(ip, await existingApp(appId), windowMs, ruleId),
  ban: async (req) => createBan({ ...req, appId: await existingApp(req.appId ?? null) }),
  recordEvent: async (e) => recordEvent({ ...e, appId: await existingApp(e.appId ?? null) }),
  markerFor: async (ip, appId) => markerFor(ip, await existingApp(appId)),
  activeMarkers: () => activeCanaries(),
  markUsed,
  appForHost,
  robotsFor: renderAppRobots,
  allowed: isExempt,
  blockedRange: blockedRangeFor,
  banLookup,
  recordBlock,
  queueReport: queueAbuseReport,
  blocksFor,
};

async function handle(request: Request, { params }: { params: Promise<{ kind: string }> }): Promise<Response> {
  const { kind } = await params;
  if (!(GUARD_KINDS as readonly string[]).includes(kind)) {
    return new Response("Not Found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  return handleGuardRequest(kind as GuardKind, request, deps);
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
