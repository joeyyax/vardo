// GET /healthz on VARDO_WORKER_HEALTH_PORT, read by Docker's healthcheck and so by the watchdog.

import { createServer, type Server } from "http";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { readJobs } from "@/lib/worker/jobs";
import { LOOP_REGISTRY } from "@/lib/worker/registry";
import { startedLoops } from "@/lib/worker/start";
import { bootState } from "./boot";

const log = logger.child("worker");

const PROBE_TIMEOUT_MS = 3000;

export type HealthInput = {
  booted: boolean;
  draining: boolean;
  database: boolean;
  redis: boolean;
  staleLoops: string[];
};

export type HealthVerdict = {
  code: 200 | 503;
  status: "ok" | "degraded" | "draining" | "booting" | "unhealthy";
};

/** Draining reads healthy so nothing restarts a worker finishing its work; Redis down only degrades. */
export function healthVerdict(h: HealthInput): HealthVerdict {
  if (h.draining) return { code: 200, status: "draining" };
  if (!h.booted) return { code: 503, status: "booting" };
  if (!h.database || h.staleLoops.length > 0) return { code: 503, status: "unhealthy" };
  if (!h.redis) return { code: 200, status: "degraded" };
  return { code: 200, status: "ok" };
}

function within<T>(promise: Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref())]);
}

const pingDb = () => within(db.execute(sql`SELECT 1`)).then(() => true, () => false);
const pingRedis = () => within(redis.ping()).then((r) => r === "PONG", () => false);

/** Critical loops this process runs whose heartbeat is stale. */
export async function staleCriticalLoops(): Promise<string[]> {
  const running = startedLoops();
  const names = LOOP_REGISTRY.filter((e) => e.critical && running.has(e.name)).map((e) => e.name);
  if (names.length === 0) return [];
  const { jobs } = await within(readJobs(names));
  return jobs.filter((j) => j.state === "stale").map((j) => j.name);
}

export async function readHealth(): Promise<HealthInput> {
  const state = bootState();
  const [database, redisUp] = await Promise.all([pingDb(), pingRedis()]);
  const staleLoops = state.booted && database ? await staleCriticalLoops().catch(() => []) : [];
  return { booted: state.booted, draining: state.draining, database, redis: redisUp, staleLoops };
}

export function startHealthServer(port: number, workerId: string): Server {
  const startedAt = Date.now();
  const server = createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    void readHealth().then((input) => {
      const verdict = healthVerdict(input);
      res.writeHead(verdict.code, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: verdict.code === 200,
          status: verdict.status,
          draining: input.draining,
          database: input.database,
          redis: input.redis,
          staleLoops: input.staleLoops,
          bootError: bootState().bootError,
          worker: workerId,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        }),
      );
    });
  });
  // Loopback only: Docker's healthcheck, the watchdog and the CLI read it from inside the container.
  server.listen(port, "127.0.0.1", () => log.info(`Health on 127.0.0.1:${port}/healthz`));
  return server;
}
