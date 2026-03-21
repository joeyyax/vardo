import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { sql } from "drizzle-orm";

// GET /api/health — unauthenticated, for Traefik/Docker/external monitoring
export async function GET() {
  const services: Record<string, string> = {};
  let healthy = true;

  // Check PostgreSQL
  try {
    await db.execute(sql`SELECT 1`);
    services.postgres = "ok";
  } catch (err) {
    healthy = false;
    services.postgres = err instanceof Error ? err.message : "unreachable";
  }

  // Check Redis
  try {
    const pong = await redis.ping();
    services.redis = pong === "PONG" ? "ok" : "unexpected response";
    if (services.redis !== "ok") healthy = false;
  } catch (err) {
    healthy = false;
    services.redis = err instanceof Error ? err.message : "unreachable";
  }

  return NextResponse.json(
    { status: healthy ? "ok" : "unhealthy", services },
    { status: healthy ? 200 : 503 },
  );
}
