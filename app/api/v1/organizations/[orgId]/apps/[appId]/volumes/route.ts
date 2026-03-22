import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { listContainers, inspectContainer } from "@/lib/docker/client";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

type VolumeInfo = {
  name: string;
  mountPath: string;
  type: "named" | "anonymous" | "bind";
  persistent: boolean;
  source: string;
};

// GET — list all volumes for this app (from Docker + saved config)
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, persistentVolumes: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Get volumes from running containers
    const dockerVolumes: VolumeInfo[] = [];
    try {
      const containers = await listContainers(app.name);
      for (const container of containers) {
        try {
          const info = await inspectContainer(container.id);
          for (const mount of info.mounts) {
            dockerVolumes.push({
              name: mount.type === "volume" ? mount.source.split("/").pop() || mount.source : mount.source,
              mountPath: mount.destination,
              type: mount.type === "volume" ? "named" : "bind",
              persistent: false,
              source: mount.source,
            });
          }
        } catch { /* skip */ }
      }
    } catch { /* Docker not available */ }

    // Merge with saved persistent volume config
    const savedVolumes = (app.persistentVolumes as { name: string; mountPath: string }[] | null) || [];
    const persistentNames = new Set(savedVolumes.map((v) => v.name));

    // Mark Docker volumes as persistent if they match saved config
    for (const vol of dockerVolumes) {
      if (persistentNames.has(vol.name)) {
        vol.persistent = true;
      }
    }

    // Add saved volumes that aren't running (may not be deployed yet)
    for (const saved of savedVolumes) {
      if (!dockerVolumes.find((v) => v.name === saved.name)) {
        dockerVolumes.push({
          name: saved.name,
          mountPath: saved.mountPath,
          type: "named",
          persistent: true,
          source: saved.name,
        });
      }
    }

    return NextResponse.json({ volumes: dockerVolumes });
  } catch (error) {
    return handleRouteError(error);
  }
}

// PUT — update persistent volumes config
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const volumes = body.volumes as { name: string; mountPath: string }[];

    const [updated] = await db
      .update(apps)
      .set({ persistentVolumes: volumes, updatedAt: new Date() })
      .where(and(eq(apps.id, appId), eq(apps.organizationId, orgId)))
      .returning({ id: apps.id });

    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
