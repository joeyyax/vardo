import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export type ServiceStatus = {
  name: string;
  description: string;
  status: "healthy" | "unhealthy" | "unconfigured";
  latencyMs?: number;
};

export type AuthConfig = {
  passkeys: boolean;
  magicLink: boolean;
  github: boolean;
  passwords: boolean;
  twoFactor: boolean;
};

export type SystemHealth = {
  services: ServiceStatus[];
  auth: AuthConfig;
};

async function checkService(
  name: string,
  description: string,
  check: () => Promise<void>,
): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await check();
    return { name, description, status: "healthy", latencyMs: Date.now() - start };
  } catch {
    return { name, description, status: "unhealthy", latencyMs: Date.now() - start };
  }
}

/**
 * Check health of all infrastructure services and return auth config.
 */
export async function getSystemHealth(): Promise<SystemHealth> {
  const services = await Promise.all([
    checkService("PostgreSQL", "Primary database", async () => {
      await db.execute(sql`SELECT 1`);
    }),
    checkService("Redis", "Cache and time-series metrics", async () => {
      const Redis = (await import("ioredis")).default;
      const url = process.env.REDIS_URL || "redis://localhost:6379";
      const redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 2000 });
      await redis.ping();
      redis.disconnect();
    }),
    checkService("Docker", "Container runtime", async () => {
      const { isDockerAvailable } = await import("@/lib/docker/client");
      const ok = await isDockerAvailable();
      if (!ok) throw new Error("unreachable");
    }),
    checkService("cAdvisor", "Container metrics", async () => {
      const url = process.env.CADVISOR_URL || "http://localhost:8081";
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`${res.status}`);
    }),
    checkLoki(),
    checkTraefik(),
  ]);

  const auth: AuthConfig = {
    passkeys: true, // always enabled via plugin
    magicLink: true, // always enabled via plugin
    github: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    passwords: false, // explicitly disabled
    twoFactor: true, // always enabled via plugin
  };

  return { services, auth };
}

async function checkLoki(): Promise<ServiceStatus> {
  const url = process.env.LOKI_URL || "http://localhost:3100";
  if (!url) {
    return { name: "Loki", description: "Log aggregation", status: "unconfigured" };
  }
  return checkService("Loki", "Log aggregation", async () => {
    const res = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`${res.status}`);
  });
}

async function checkTraefik(): Promise<ServiceStatus> {
  return checkService("Traefik", "Reverse proxy and SSL", async () => {
    const res = await fetch("http://localhost:8080/api/overview", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`${res.status}`);
  });
}
