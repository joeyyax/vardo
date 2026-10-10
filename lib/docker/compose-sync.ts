// Syncs display-only child app records from a compose file's services. The compose file stays the source of truth.

import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { apps } from "@/lib/db/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ComposeFile, ComposeService } from "./compose";
import { parsePortString } from "./compose-inject";
import { inferServiceKind } from "@/lib/ui/service-kind";
import { removeComposeChild, type RemovableChild } from "./compose-child-remove";

type SyncResult = {
  created: string[];
  updated: string[];
  removed: string[];
  /** Children stopped, not removed: their service is skipped by a profile or excluded. */
  kept: string[];
};

/** A service's named volumes, shaped like apps.persistentVolumes. */
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
      if (!volName.startsWith("/") && !volName.startsWith("./") && !volName.startsWith("../")) {
        result.push({ name: volName, mountPath });
      }
    }
  }
  return result;
}

/** A service's port mappings, shaped like apps.exposedPorts. */
function parseServicePorts(
  svc: ComposeService,
): { internal: number; external?: number; protocol?: string }[] {
  if (!svc.ports) return [];

  const result: { internal: number; external?: number; protocol?: string }[] = [];
  for (const raw of svc.ports) {
    const parsed = parsePortString(raw);
    if (!parsed) continue;
    const protocolMatch = String(raw).match(/\/(tcp|udp)$/i);
    const protocol = protocolMatch ? protocolMatch[1].toLowerCase() : undefined;
    result.push({
      internal: parsed.internal,
      external: parsed.external,
      ...(protocol && protocol !== "tcp" ? { protocol } : {}),
    });
  }
  return result;
}

/** "redis-cache" -> "Redis Cache". */
function humanizeServiceName(name: string): string {
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Create or update child app records to match the compose services; remove those whose service is gone. */
export async function syncComposeServices(opts: {
  parentAppId: string;
  organizationId: string;
  projectId: string;
  compose: ComposeFile;
  parentAppName: string;
  /** Services the deploy leaves out on purpose (inactive profile, environment exclude). Their children are stopped, not removed. */
  keepServices?: string[];
  log?: (line: string) => void;
}): Promise<SyncResult> {
  const { parentAppId, organizationId, projectId, compose, parentAppName, log } = opts;
  const keepServices = new Set(opts.keepServices ?? []);

  // Undefined values would be coerced to null in Drizzle transactions.
  if (!organizationId) {
    throw new Error("syncComposeServices: organizationId is required but was undefined or empty");
  }
  if (!parentAppId) {
    throw new Error("syncComposeServices: parentAppId is required but was undefined or empty");
  }
  if (!parentAppName) {
    throw new Error("syncComposeServices: parentAppName is required but was undefined or empty");
  }

  const result: SyncResult = { created: [], updated: [], removed: [], kept: [] };

  const serviceNames = Object.keys(compose.services);

  const mountedVolumes = new Set(
    Object.values(compose.services).flatMap((svc) => parseServiceVolumes(svc).map((v) => v.name)),
  );

  /** A child's service: the recorded one, else the name suffix. */
  const serviceOf = (c: { name: string; composeService: string | null }): string | null =>
    c.composeService ?? (c.name.startsWith(`${parentAppName}-`) ? c.name.slice(parentAppName.length + 1) : null);

  /** Stop a child whose service is left out on purpose; remove one whose service is gone. */
  const retire = async (child: RemovableChild, service: string) => {
    if (keepServices.has(service)) {
      await db.update(apps).set(statusChange("stopped")).where(eq(apps.id, child.id));
      result.kept.push(service);
      return;
    }
    await removeComposeChild({ child, service, parentAppId, organizationId, mountedVolumes });
    result.removed.push(service);
    log?.(`[compose-sync] removed child app ${child.name}: service no longer in compose`);
  };

  if (serviceNames.length <= 1) {
    // Single service: stop children left from a previous multi-service compose.
    const existingChildren = await db.query.apps.findMany({
      where: and(
        eq(apps.parentAppId, parentAppId),
        eq(apps.organizationId, organizationId),
      ),
      columns: { id: true, name: true, composeService: true },
    });

    for (const child of existingChildren) {
      const service = serviceOf(child);
      if (!service) continue;
      // The remaining service runs under the parent itself.
      if (serviceNames.includes(service)) {
        await db.update(apps).set(statusChange("stopped")).where(eq(apps.id, child.id));
        continue;
      }
      await retire(child, service);
    }

    return result;
  }

  // Edit/delete guards read the child row, so children inherit the system-managed flag.
  const parent = await db.query.apps.findFirst({
    where: eq(apps.id, parentAppId),
    columns: { isSystemManaged: true },
  });
  const isSystemManaged = parent?.isSystemManaged ?? false;

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

  // Records orphaned by earlier failed attempts (no parentAppId).
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

  const childByService = new Map(
    existingChildren
      .filter((c) => c.composeService)
      .map((c) => [c.composeService!, c])
  );

  const childByName = new Map(
    existingByName.map((c) => [c.name, c])
  );

  // No db.transaction(): postgres-js parameter binding issues.
  for (const [serviceName, svc] of Object.entries(compose.services)) {
    const childName = `${parentAppName}-${serviceName}`;
    const containerName = `${parentAppName}-${serviceName}-1`;
    const displayName = humanizeServiceName(serviceName);
    const volumes = parseServiceVolumes(svc);
    const servicePorts = parseServicePorts(svc);

    const dependsOnRaw = svc.depends_on;
    const dependsOnServiceNames = dependsOnRaw
      ? Array.isArray(dependsOnRaw)
        ? dependsOnRaw
        : Object.keys(dependsOnRaw)
      : null;
    const dependsOn = dependsOnServiceNames?.map((dep) => `${parentAppName}-${dep}`) ?? null;
    const kind = inferServiceKind({
      image: svc.image,
      serviceName,
      hasPort: servicePorts.length > 0 || !!svc.expose?.length,
    });

    const existing = childByService.get(serviceName) ?? childByName.get(childName);

    if (existing) {
      await db
        .update(apps)
        .set({
          ...statusChange("active"),
          displayName,
          containerName,
          imageName: svc.image || null,
          // cpuLimit/memoryLimit are UI overrides; sync never writes them.
          persistentVolumes: volumes.length > 0 ? volumes : null,
          // Keep UI-set ports when compose declares none.
          ...(servicePorts.length > 0 ? { exposedPorts: servicePorts } : {}),
          dependsOn,
          projectId,
          parentAppId,
          composeService: serviceName,
          kind,
          isSystemManaged,
        })
        .where(eq(apps.id, existing.id));

      result.updated.push(serviceName);
      childByService.delete(serviceName);
      childByName.delete(childName);
    } else {
      // Raw SQL bypasses Drizzle/postgres-js parameter binding issues.
      const id = nanoid();
      const now = new Date().toISOString();
      const volsJson = volumes.length > 0 ? JSON.stringify(volumes) : null;
      const depsJson = dependsOn ? JSON.stringify(dependsOn) : null;
      const portsJson = servicePorts.length > 0 ? JSON.stringify(servicePorts) : null;

      await db.execute(sql`
        INSERT INTO "app" (
          "id", "organization_id", "name", "display_name", "description",
          "source", "deploy_type", "image_name", "status",
          "parent_app_id", "compose_service", "container_name", "project_id",
          "cpu_limit", "memory_limit", "priority", "persistent_volumes", "exposed_ports", "depends_on", "sort_order",
          "is_system_managed", "kind", "created_at", "updated_at"
        ) VALUES (
          ${id}, ${organizationId}, ${childName}, ${displayName}, ${`Compose service: ${serviceName}`},
          ${"direct"}, ${"compose"}, ${svc.image || null}, ${"active"},
          ${parentAppId}, ${serviceName}, ${containerName}, ${projectId},
          ${null}, ${null}, ${null}, ${volsJson}, ${portsJson}, ${depsJson}, ${0},
          ${isSystemManaged}, ${kind}, ${now}, ${now}
        )
      `);

      result.created.push(serviceName);
    }
  }

  // Children whose service left the compose file, deduped by ID across both maps.
  const orphanedById = new Map<string, { serviceName: string; child: typeof existingChildren[0] }>();
  for (const [serviceName, child] of childByService) {
    orphanedById.set(child.id, { serviceName, child });
  }
  for (const [serviceName, child] of childByName) {
    if (!orphanedById.has(child.id)) {
      orphanedById.set(child.id, { serviceName, child });
    }
  }
  // Children recorded without a composeService never enter the maps above.
  for (const child of existingChildren) {
    const service = serviceOf(child);
    if (service && !child.composeService && !serviceNames.includes(service) && !orphanedById.has(child.id)) {
      orphanedById.set(child.id, { serviceName: service, child });
    }
  }
  for (const [, { serviceName, child }] of orphanedById) {
    await retire(child, serviceOf(child) ?? serviceName);
  }

  if (log) {
    if (result.created.length > 0) {
      log(`[compose-sync] Created child services: ${result.created.join(", ")}`);
    }
    if (result.updated.length > 0) {
      log(`[compose-sync] Updated child services: ${result.updated.join(", ")}`);
    }
    if (result.kept.length > 0) {
      log(`[compose-sync] Stopped children of skipped services: ${result.kept.join(", ")}`);
    }
  }

  return result;
}
