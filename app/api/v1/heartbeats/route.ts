import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { siteHeartbeats, scopeClients } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// Simple in-memory rate limit: 1 per 10s per scopeClientId+IP
const recentHeartbeats = new Map<string, number>();
const RATE_LIMIT_MS = 10_000;

// Clean up stale entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentHeartbeats) {
    if (now - ts > RATE_LIMIT_MS * 2) {
      recentHeartbeats.delete(key);
    }
  }
}, 60_000);

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// POST /api/v1/heartbeats
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { scopeClientId, pageUrl, metrics, metadata } = body;

    if (!scopeClientId || !pageUrl || !metrics) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Rate limit
    const ip = getClientIp(request);
    const rateKey = `${scopeClientId}:${ip}`;
    const lastSeen = recentHeartbeats.get(rateKey);
    if (lastSeen && Date.now() - lastSeen < RATE_LIMIT_MS) {
      return NextResponse.json({ ok: true }); // Silently drop
    }
    recentHeartbeats.set(rateKey, Date.now());

    // Verify scope client exists and is enabled
    const sc = await db.query.scopeClients.findFirst({
      where: eq(scopeClients.id, scopeClientId),
      columns: { id: true, organizationId: true, enabled: true },
    });

    if (!sc || !sc.enabled) {
      return NextResponse.json({ error: "Invalid scope client" }, { status: 400 });
    }

    // Compute ping from navigation timing if available
    const pingMs = metrics?.navigation?.ttfb
      ? Math.round(metrics.navigation.ttfb)
      : null;

    await db.insert(siteHeartbeats).values({
      organizationId: sc.organizationId,
      scopeClientId,
      pageUrl,
      metrics,
      metadata: metadata || null,
      pingMs,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error storing heartbeat:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
