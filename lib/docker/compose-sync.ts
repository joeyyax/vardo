// ---------------------------------------------------------------------------
// Compose Decomposition: sync child app records from compose YAML services
//
// After a compose-based deploy succeeds, this module parses the compose YAML
// and creates/updates/cleans up child app records for each service. The compose
// file stays the single source of truth -- nothing is split. The decomposition
// is purely presentational so each service gets its own card with metrics,
// logs, status, and dependency relationships.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ComposeFile, ComposeService } from "./compose";

type SyncResult = {
  created: string[];
  updated: string[];
  removed: string[];
};

/**
 * Parse resource limits from a compose service's deploy.resources.limits.
 * Returns { cpuLimit, memoryLimit } in the same units as the apps table.
 */
function parseResourceLimits(svc: ComposeService): {
  cpuLimit: number | null;
  memoryLimit: number | null;
} {
  const limits = svc.deploy?.resources?.limits;
  if (!limits) return { cpuLimit: null, memoryLimit: null };

  let cpuLimit: number | null = null;
  if (limits.cpus) {
    const parsed = parseFloat(limits.cpus);
    if (!isNaN(parsed)) cpuLimit = parsed;
  }

  let memoryLimit: number | null = null;
  if (limits.memory) {
    const mem = limits.memory.trim().toLowerCase();
    if (mem.endsWith("g")) {
      memoryLimit = parseFloat(mem) * 1024;
    } else if (mem.endsWith("m")) {
      memoryLimit = parseFloat(mem);
    } else if (mem.endsWith("k")) {
      memoryLimit = Math.round(parseFloat(mem) / 1024);
    } else {
      // Assume bytes
      const bytes = parseInt(mem, 10);
      if (!isNaN(bytes)) memoryLimit = Math.round(bytes / (1024 * 1024));
    }
  }

  return { cpuLimit, memoryLimit };
}

/**
 * Extract volume declarations from a compose service.
 * Returns in the same format as apps.persistentVolumes.
 */
function parseServiceVolumes(
  svc: ComposeService,
  composeVolumes?: Record<string, unknown>
): { name: string; mountPath: string }[] {
  if (!svc.volumes) return [];

  const result: { name: string; mountPath: string }[] = [];
  for (const vol of svc.volumes) {
    const parts = vol.split(":");
    if (parts.length >= 2) {
      const volName = parts[0];
      const mountPath = parts[1];
      // Only include named volumes (not bind mounts)
      if (!volName.startsWith("/") && !volName.startsWith("./") && !volName.startsWith("../")) {
        result.push({ name: volName, mountPath });
      }
    }
  }
  return result;
}

/**
 * Humanize a docker-compose service name into a display name.
 * e.g. "redis-cache" -> "Redis Cache", "postgres" -> "Postgres"
 */
function humanizeServiceName(name: string): string {
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Sync child app records from a parsed compose file after a successful deploy.
 *
 * For each service in the compose YAML:
 * - If a child record exists (matched by parentAppId + composeService), update it
 * - If not, create one with name, status, dependencies, volumes, resource limits
 * - If a previous child record's service was removed from the YAML, mark it stopped
 *
 * @param parentAppId - The parent compose app's ID
 * @param organizationId - The org scope
 * @param projectId - The project this app belongs to (nullable)
 * @param compose - Parsed compose file
 * @param parentAppName - The parent app's name (used for generating child names/container names)
 * @param log - Optional logger
 */
export async function syncComposeServices(opts: {
  parentAppId: string;
  organizationId: string;
  projectId: string | null;
  compose: ComposeFile;
  parentAppName: string;
  log?: (line: string) => void;
}): Promise<SyncResult> {
  const { parentAppId, organizationId, projectId, compose, parentAppName, log } = opts;
  const result: SyncResult = { created: [], updated: [], removed: [] };

  const serviceNames = Object.keys(compose.services);

  // Skip decomposition for single-service compose files -- there's nothing to decompose
  if (serviceNames.length <= 1) {
    // Still clean up any orphaned children from a previous multi-service compose
    const existingChildren = await db.query.apps.findMany({
      where: and(
        eq(apps.parentAppId, parentAppId),
        eq(apps.organizationId, organizationId),
      ),
      columns: { id: true, name: true, composeService: true },
    });

    if (existingChildren.length > 0) {
      await db.transaction(async (tx) => {
        for (const child of existingChildren) {
          await tx
            .update(apps)
            .set({ status: "stopped", updatedAt: new Date() })
            .where(eq(apps.id, child.id));
          result.removed.push(child.composeService || child.name);
        }
      });
    }

    return result;
  }

  // Fetch existing child records for this parent
  const existingChildren = await db.query.apps.findMany({
    where: and(
      eq(apps.parentAppId, parentAppId),
      eq(apps.organizationId, organizationId),
    ),
    columns: {
      id: true,
      name: true,
      composeService: true,
      status: true,
    },
  });

  const childByService = new Map(
    existingChildren
      .filter((c) => c.composeService)
      .map((c) => [c.composeService!, c])
  );

  // Wrap all create/update/delete operations in a transaction for atomicity
  await db.transaction(async (tx) => {
    // Process each service in the compose file
    for (const [serviceName, svc] of Object.entries(compose.services)) {
      const childName = `${parentAppName}-${serviceName}`;
      const containerName = `${parentAppName}-${serviceName}-1`;
      const displayName = humanizeServiceName(serviceName);
      const { cpuLimit, memoryLimit } = parseResourceLimits(svc);
      const volumes = parseServiceVolumes(svc, compose.volumes);

      // Map compose depends_on to child app names (prefixed with parent).
      // depends_on may be a string[] or an object keyed by service name.
      const dependsOnRaw = svc.depends_on;
      const dependsOnServiceNames = dependsOnRaw
        ? Array.isArray(dependsOnRaw)
          ? dependsOnRaw
          : Object.keys(dependsOnRaw)
        : null;
      const dependsOn = dependsOnServiceNames?.map((dep) => `${parentAppName}-${dep}`) ?? null;

      const existing = childByService.get(serviceName);

      if (existing) {
        // Update existing child record
        await tx
          .update(apps)
          .set({
            status: "active",
            displayName,
            containerName,
            imageName: svc.image || null,
            cpuLimit,
            memoryLimit,
            persistentVolumes: volumes.length > 0 ? volumes : null,
            dependsOn,
            updatedAt: new Date(),
          })
          .where(eq(apps.id, existing.id));

        result.updated.push(serviceName);
        childByService.delete(serviceName);
      } else {
        // Create new child record
        const id = nanoid();
        await tx.insert(apps).values({
          id,
          organizationId,
          name: childName,
          displayName,
          description: `Compose service: ${serviceName}`,
          source: "direct",
          deployType: "compose",
          imageName: svc.image || null,
          status: "active",
          parentAppId,
          composeService: serviceName,
          containerName,
          projectId,
          cpuLimit,
          memoryLimit,
          persistentVolumes: volumes.length > 0 ? volumes : null,
          dependsOn,
          sortOrder: 0,
        });

        result.created.push(serviceName);
      }
    }

    // Mark orphaned children (services removed from compose YAML) as stopped
    for (const [serviceName, child] of childByService) {
      await tx
        .update(apps)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(apps.id, child.id));
      result.removed.push(serviceName);
    }
  });

  if (log) {
    if (result.created.length > 0) {
      log(`[compose-sync] Created child services: ${result.created.join(", ")}`);
    }
    if (result.updated.length > 0) {
      log(`[compose-sync] Updated child services: ${result.updated.join(", ")}`);
    }
    if (result.removed.length > 0) {
      log(`[compose-sync] Orphaned services stopped: ${result.removed.join(", ")}`);
    }
  }

  return result;
}
