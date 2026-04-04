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
import { eq, and, sql, inArray } from "drizzle-orm";
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

  // Validate required fields - protects against undefined values being coerced to null in Drizzle transactions
  if (!organizationId) {
    throw new Error("syncComposeServices: organizationId is required but was undefined or empty");
  }
  if (!parentAppId) {
    throw new Error("syncComposeServices: parentAppId is required but was undefined or empty");
  }
  if (!parentAppName) {
    throw new Error("syncComposeServices: parentAppName is required but was undefined or empty");
  }

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

  // Also fetch any existing records by name that might be orphaned (no parentAppId)
  // This handles cleanup from previous failed attempts
  const childNames = serviceNames.map((svc) => `${parentAppName}-${svc}`);
  const existingByName = childNames.length > 0
    ? await db.query.apps.findMany({
        where: and(
          eq(apps.organizationId, organizationId),
          inArray(apps.name, childNames),
        ),
        columns: {
          id: true,
          name: true,
          composeService: true,
          status: true,
          parentAppId: true,
        },
      })
    : [];

  // Merge: childByService for matching by composeService
  const childByService = new Map(
    existingChildren
      .filter((c) => c.composeService)
      .map((c) => [c.composeService!, c])
  );

  // childByName for matching by generated name (catches orphaned records)
  const childByName = new Map(
    existingByName.map((c) => [c.name, c])
  );

  // Process each service in the compose file
  // NOTE: Not using db.transaction() due to postgres-js parameter binding issues
  // These are display-only child records, so atomicity is less critical than correctness
  for (const [serviceName, svc] of Object.entries(compose.services)) {
    const childName = `${parentAppName}-${serviceName}`;
    const containerName = `${parentAppName}-${serviceName}-1`;
    const displayName = humanizeServiceName(serviceName);
    const { cpuLimit, memoryLimit } = parseResourceLimits(svc);
    const volumes = parseServiceVolumes(svc);

    // Map compose depends_on to child app names (prefixed with parent).
    // depends_on may be a string[] or an object keyed by service name.
    const dependsOnRaw = svc.depends_on;
    const dependsOnServiceNames = dependsOnRaw
      ? Array.isArray(dependsOnRaw)
        ? dependsOnRaw
        : Object.keys(dependsOnRaw)
      : null;
    const dependsOn = dependsOnServiceNames?.map((dep) => `${parentAppName}-${dep}`) ?? null;

    const existing = childByService.get(serviceName) ?? childByName.get(childName);

    if (existing) {
      // Update existing child record (may be orphaned from previous failed attempt)
      await db
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
          projectId,
          parentAppId, // Re-parent if it was orphaned
          composeService: serviceName, // Set if it was missing
          updatedAt: new Date(),
        })
        .where(eq(apps.id, existing.id));

      result.updated.push(serviceName);
      childByService.delete(serviceName);
      childByName.delete(childName);
    } else {
      // Create new child record
      // NOTE: Using raw SQL to bypass Drizzle/postgres-js parameter binding issues
      const id = nanoid();
      const now = new Date().toISOString();
      const volsJson = volumes.length > 0 ? JSON.stringify(volumes) : null;
      const depsJson = dependsOn ? JSON.stringify(dependsOn) : null;

      await db.execute(sql`
        INSERT INTO "app" (
          "id", "organization_id", "name", "display_name", "description",
          "source", "deploy_type", "image_name", "status",
          "parent_app_id", "compose_service", "container_name", "project_id",
          "cpu_limit", "memory_limit", "persistent_volumes", "depends_on", "sort_order",
          "created_at", "updated_at"
        ) VALUES (
          ${id}, ${organizationId}, ${childName}, ${displayName}, ${`Compose service: ${serviceName}`},
          ${"direct"}, ${"compose"}, ${svc.image || null}, ${"active"},
          ${parentAppId}, ${serviceName}, ${containerName}, ${projectId},
          ${cpuLimit}, ${memoryLimit}, ${volsJson}, ${depsJson}, ${0},
          ${now}, ${now}
        )
      `);

      result.created.push(serviceName);
    }
  }

  // Mark orphaned children (services removed from compose YAML) as stopped
  // Deduplicate by child ID since the same record can appear in both maps
  const orphanedById = new Map<string, { serviceName: string; child: typeof existingChildren[0] }>();
  for (const [serviceName, child] of childByService) {
    orphanedById.set(child.id, { serviceName, child });
  }
  for (const [serviceName, child] of childByName) {
    if (!orphanedById.has(child.id)) {
      orphanedById.set(child.id, { serviceName, child });
    }
  }
  for (const [, { serviceName, child }] of orphanedById) {
    await db
      .update(apps)
      .set({ status: "stopped", updatedAt: new Date() })
      .where(eq(apps.id, child.id));
    result.removed.push(child.composeService || serviceName);
  }

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
