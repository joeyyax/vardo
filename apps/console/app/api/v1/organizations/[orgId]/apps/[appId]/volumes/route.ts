import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, volumes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { listContainers, inspectContainer } from "@/lib/docker/client";
import { z } from "zod";
import { nanoid } from "nanoid";
import { exec } from "child_process";
import { promisify } from "util";
import { verifyOrgAccess } from "@/lib/api/verify-access";

const execAsync = promisify(exec);

const volumeSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/, "Invalid volume name"),
  mountPath: z.string().min(1)
    .refine((p) => p.startsWith("/"), "Mount path must be absolute")
    .refine((p) => !p.includes(".."), "Mount path must not contain '..'"),
  persistent: z.boolean().default(true),
  description: z.string().optional(),
  maxSizeBytes: z.number().int().positive().nullable().optional(),
  warnAtPercent: z.number().int().min(1).max(100).optional(),
}).strict();

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

type VolumeInfo = {
  id: string | null;
  name: string;
  mountPath: string;
  type: "named" | "anonymous" | "bind";
  persistent: boolean;
  shared: boolean;
  description: string | null;
  maxSizeBytes: number | null;
  warnAtPercent: number | null;
  ignorePatterns: string[] | null;
  driftCount: number;
  source: string;
  sizeBytes: number | null;
};

// GET — list all volumes for this app (from Docker + volumes table)
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Load saved volumes from the volumes table
    const savedVolumes = await db.query.volumes.findMany({
      where: eq(volumes.appId, appId),
    });
    const savedByName = new Map(savedVolumes.map((v) => [v.name, v]));

    // Get volumes from running containers
    const dockerVolumes: VolumeInfo[] = [];
    try {
      const containers = await listContainers(app.name);
      for (const container of containers) {
        try {
          const info = await inspectContainer(container.id);
          for (const mount of info.mounts) {
            const name = mount.type === "volume" ? mount.source.split("/").pop() || mount.source : mount.source;
            const saved = savedByName.get(name);
            dockerVolumes.push({
              id: saved?.id ?? null,
              name,
              mountPath: mount.destination,
              type: mount.type === "volume" ? "named" : "bind",
              persistent: saved?.persistent ?? false,
              shared: saved?.shared ?? false,
              description: saved?.description ?? null,
              maxSizeBytes: saved?.maxSizeBytes ?? null,
              warnAtPercent: saved?.warnAtPercent ?? null,
              ignorePatterns: saved?.ignorePatterns ?? null,
              driftCount: saved?.driftCount ?? 0,
              source: mount.source,
              sizeBytes: null,
            });
          }
        } catch { /* skip */ }
      }

      // Measure all volume sizes in parallel (5s timeout per volume)
      const measurable = dockerVolumes
        .map((vol, idx) => ({ vol, idx }))
        .filter(({ vol }) => {
          if (vol.type !== "named") return false;
          const volName = vol.source.split("/").pop() || "";
          return /^[a-zA-Z0-9._-]+$/.test(volName);
        });

      if (measurable.length > 0) {
        const results = await Promise.allSettled(
          measurable.map(({ vol }) => {
            const volName = vol.source.split("/").pop() || "";
            return execAsync(
              `docker run --rm -v "${volName}:/data" alpine du -sb /data`,
              { timeout: 5000 }
            );
          })
        );

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.status === "fulfilled") {
            const bytes = parseInt(result.value.stdout.split("\t")[0]);
            if (!isNaN(bytes)) {
              dockerVolumes[measurable[i].idx].sizeBytes = bytes;
            }
          }
        }
      }
    } catch { /* Docker not available */ }

    // Mark Docker volumes as persistent if they match saved config
    const dockerNames = new Set(dockerVolumes.map((v) => v.name));
    for (const vol of dockerVolumes) {
      const saved = savedByName.get(vol.name);
      if (saved) {
        vol.persistent = saved.persistent;
        vol.id = saved.id;
      }
    }

    // Add saved volumes that aren't running (may not be deployed yet)
    for (const saved of savedVolumes) {
      if (!dockerNames.has(saved.name)) {
        dockerVolumes.push({
          id: saved.id,
          name: saved.name,
          mountPath: saved.mountPath,
          type: "named",
          persistent: saved.persistent,
          shared: saved.shared,
          description: saved.description,
          maxSizeBytes: saved.maxSizeBytes,
          warnAtPercent: saved.warnAtPercent,
          ignorePatterns: saved.ignorePatterns,
          driftCount: saved.driftCount ?? 0,
          source: saved.name,
          sizeBytes: null,
        });
      }
    }

    return NextResponse.json({ volumes: dockerVolumes });
  } catch (error) {
    return handleRouteError(error);
  }
}

// PUT — sync volumes config (replaces all volumes for this app)
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const parsed = z.array(volumeSchema).safeParse(body.volumes);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    const incoming = parsed.data;

    // Verify app exists
    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true },
    });
    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Load existing volumes
    const existing = await db.query.volumes.findMany({
      where: eq(volumes.appId, appId),
    });
    const existingByName = new Map(existing.map((v) => [v.name, v]));
    const incomingNames = new Set(incoming.map((v) => v.name));

    // Delete volumes not in the incoming list
    for (const vol of existing) {
      if (!incomingNames.has(vol.name)) {
        await db.delete(volumes).where(eq(volumes.id, vol.id));
      }
    }

    // Upsert incoming volumes
    for (const vol of incoming) {
      const prev = existingByName.get(vol.name);
      if (prev) {
        await db.update(volumes)
          .set({
            mountPath: vol.mountPath,
            persistent: vol.persistent,
            description: vol.description ?? prev.description,
            maxSizeBytes: vol.maxSizeBytes !== undefined ? vol.maxSizeBytes : prev.maxSizeBytes,
            warnAtPercent: vol.warnAtPercent ?? prev.warnAtPercent,
            updatedAt: new Date(),
          })
          .where(eq(volumes.id, prev.id));
      } else {
        await db.insert(volumes).values({
          id: nanoid(),
          appId,
          organizationId: orgId,
          name: vol.name,
          mountPath: vol.mountPath,
          persistent: vol.persistent,
          description: vol.description,
          maxSizeBytes: vol.maxSizeBytes ?? null,
          warnAtPercent: vol.warnAtPercent ?? 80,
        });
      }
    }

    // Keep legacy JSONB in sync during migration period
    const persistentList = incoming
      .filter((v) => v.persistent)
      .map((v) => ({ name: v.name, mountPath: v.mountPath }));
    await db.update(apps)
      .set({ persistentVolumes: persistentList, updatedAt: new Date() })
      .where(eq(apps.id, appId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
