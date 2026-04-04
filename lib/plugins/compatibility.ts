// ---------------------------------------------------------------------------
// Plugin compatibility checker
//
// Runs before enabling a plugin to verify its requirements are met:
// feature dependencies, service availability, and conflict detection.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { plugins } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { redis } from "@/lib/redis";
import { getEnabledPlugins, isCapabilityAvailable } from "./registry";
import type { PluginManifest, ServiceRequirement } from "./manifest";
import { getPluginSetting } from "./registry";
import net from "net";

const SERVICE_CHECK_TIMEOUT_MS = 2500;

export type CompatibilityIssue = {
  type: "missing_feature" | "missing_service" | "conflict" | "service_unavailable";
  severity: "error" | "warning";
  message: string;
  detail?: string;
  /** Service name for service_unavailable issues (used by provision UI). */
  serviceName?: string;
};

export type CompatibilityResult = {
  compatible: boolean;
  issues: CompatibilityIssue[];
};

/**
 * Load a plugin manifest by ID, checking both in-memory cache and DB.
 * Needed because disabled plugins won't be in the cache.
 */
async function loadManifest(pluginId: string): Promise<PluginManifest | null> {
  const row = await db.query.plugins.findFirst({
    where: eq(plugins.id, pluginId),
  });
  if (!row?.manifest) return null;
  return row.manifest as unknown as PluginManifest;
}

/**
 * Check compatibility for a plugin before enabling it.
 *
 * 1. Validates all required feature capabilities are active
 * 2. Checks required services are reachable (health check)
 * 3. Detects conflicts with currently enabled plugins
 */
export async function checkPluginCompatibility(
  pluginId: string,
): Promise<CompatibilityResult> {
  const manifest = await loadManifest(pluginId);
  if (!manifest) {
    return {
      compatible: false,
      issues: [
        {
          type: "missing_feature",
          severity: "error",
          message: `Plugin "${pluginId}" not found in registry`,
        },
      ],
    };
  }

  const issues: CompatibilityIssue[] = [];

  // Run all checks concurrently
  const [featureIssues, serviceIssues, conflictIssues] = await Promise.all([
    checkFeatures(manifest),
    checkServices(manifest),
    checkConflicts(manifest),
  ]);

  issues.push(...featureIssues, ...serviceIssues, ...conflictIssues);

  return {
    compatible: !issues.some((i) => i.severity === "error"),
    issues,
  };
}

// ---------------------------------------------------------------------------
// Feature checks
// ---------------------------------------------------------------------------

async function checkFeatures(manifest: PluginManifest): Promise<CompatibilityIssue[]> {
  const issues: CompatibilityIssue[] = [];
  const requiredFeatures = manifest.requires?.features ?? [];

  for (const feature of requiredFeatures) {
    const available = await isCapabilityAvailable(feature);
    if (!available) {
      issues.push({
        type: "missing_feature",
        severity: "error",
        message: `Required capability "${feature}" is not provided by any enabled plugin`,
        detail: `Enable a plugin that provides "${feature}" before enabling ${manifest.name}.`,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Service checks
// ---------------------------------------------------------------------------

async function checkServices(manifest: PluginManifest): Promise<CompatibilityIssue[]> {
  const issues: CompatibilityIssue[] = [];

  // Check requires.redis
  if (manifest.requires?.redis) {
    const redisOk = await checkRedis();
    if (!redisOk) {
      issues.push({
        type: "service_unavailable",
        severity: "error",
        message: "Redis is required but not reachable",
        detail: "Ensure Redis is running and REDIS_URL is configured correctly.",
      });
    }
  }

  // Check requires.services
  const services = manifest.requires?.services ?? [];
  const serviceChecks = services.map((svc) => checkSingleService(manifest.id, svc));
  const serviceResults = await Promise.all(serviceChecks);
  issues.push(...serviceResults.filter(Boolean) as CompatibilityIssue[]);

  return issues;
}

async function checkSingleService(
  pluginId: string,
  svc: ServiceRequirement,
): Promise<CompatibilityIssue | null> {
  // Resolve the endpoint — prefer user-configured setting over default
  const customUrl = await getPluginSetting(pluginId, svc.setting);
  const endpoint = customUrl || svc.default;

  let reachable = false;
  try {
    switch (svc.check) {
      case "http":
        reachable = await checkHttp(endpoint);
        break;
      case "redis":
        reachable = await checkRedis(endpoint);
        break;
      case "tcp":
        reachable = await checkTcp(endpoint);
        break;
    }
  } catch {
    reachable = false;
  }

  if (!reachable) {
    return {
      type: "service_unavailable",
      severity: svc.provisionable ? "warning" : "error",
      message: `Service "${svc.name}" is not reachable at ${endpoint}`,
      detail: svc.provisionable
        ? `This service can be auto-provisioned. Vardo will add it to your compose stack.`
        : `Ensure "${svc.name}" is running and accessible at the configured URL.`,
      serviceName: svc.name,
    };
  }

  return null;
}

// Accepts any non-5xx response as "service available" — auth-gated
// services return 401/403 but are still running and reachable.
async function checkHttp(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SERVICE_CHECK_TIMEOUT_MS);
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function checkRedis(url?: string): Promise<boolean> {
  try {
    if (url) {
      // Check a specific Redis endpoint
      const { default: Redis } = await import("ioredis");
      const client = new Redis(url, {
        connectTimeout: SERVICE_CHECK_TIMEOUT_MS,
        lazyConnect: true,
        maxRetriesPerRequest: 0,
      });
      try {
        await client.connect();
        const pong = await client.ping();
        await client.quit();
        return pong === "PONG";
      } catch {
        client.disconnect();
        return false;
      }
    }

    // Use the shared Redis client
    const pong = await Promise.race([
      redis.ping(),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), SERVICE_CHECK_TIMEOUT_MS),
      ),
    ]);
    return pong === "PONG";
  } catch {
    return false;
  }
}

async function checkTcp(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const url = new URL(endpoint);
      const host = url.hostname;
      const port = parseInt(url.port, 10) || 80;

      const socket = net.createConnection({ host, port }, () => {
        socket.destroy();
        resolve(true);
      });

      socket.setTimeout(SERVICE_CHECK_TIMEOUT_MS);

      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });

      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Conflict checks
// ---------------------------------------------------------------------------

async function checkConflicts(manifest: PluginManifest): Promise<CompatibilityIssue[]> {
  const issues: CompatibilityIssue[] = [];
  const conflicts = manifest.conflicts ?? [];
  if (conflicts.length === 0) return issues;

  const enabled = await getEnabledPlugins();

  for (const conflictCapability of conflicts) {
    const conflicting = enabled.find((p) => p.provides?.includes(conflictCapability));
    if (conflicting) {
      issues.push({
        type: "conflict",
        severity: "error",
        message: `Conflicts with "${conflicting.name}" — both provide "${conflictCapability}"`,
        detail: `Disable "${conflicting.name}" before enabling ${manifest.name}.`,
      });
    }
  }

  return issues;
}
