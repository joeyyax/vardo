import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/logger";

const log = logger.child("health");

const TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), TIMEOUT_MS),
    ),
  ]);
}

// GET /api/health — unauthenticated, for Traefik/Docker/external monitoring
export async function GET() {
  const services: Record<string, string> = {};
  let healthy = true;

  // Check PostgreSQL
  try {
    await withTimeout(db.execute(sql`SELECT 1`), "postgres");
    services.postgres = "ok";
  } catch (err) {
    healthy = false;
    services.postgres = "error";
    log.error(
      "postgres check failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // Check Redis
  try {
    const pong = await withTimeout(redis.ping(), "redis");
    services.redis = pong === "PONG" ? "ok" : "unexpected response";
    if (services.redis !== "ok") healthy = false;
  } catch (err) {
    healthy = false;
    services.redis = "error";
    log.error(
      "redis check failed:",
      err instanceof Error ? err.message : err,
    );
  }

  return NextResponse.json(
    { status: healthy ? "ok" : "unhealthy", services },
    { status: healthy ? 200 : 503 },
  );
}
