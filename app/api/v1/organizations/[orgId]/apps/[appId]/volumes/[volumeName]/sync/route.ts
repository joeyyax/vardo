import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, volumes } from "@/lib/db/schema";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { eq, and } from "drizzle-orm";
import { syncFilesFromImage } from "@/lib/volumes/diff";
import { listContainers, inspectContainer, resolveVolumeName } from "@/lib/docker/client";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; volumeName: string }>;
};

const DESTRUCTIVE_THRESHOLD = 10;

// Safe path: relative, no traversal, no shell metacharacters.
const safePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/"), { message: "Path must be relative" })
  .refine((p) => !p.includes(".."), { message: "Path must not contain '..'" })
  .refine((p) => !/[;&|`$()<>\n\r\0]/.test(p), {
    message: "Path contains unsafe characters",
  });

const syncSchema = z.object({
  paths: z.array(safePathSchema).min(1).max(1000),
  confirm: z.boolean().optional(),
}).strict();

/**
 * POST — Sync specific files from the image into the volume.
 *
 * Runs a temp container, copies the specified files from the image's
 * filesystem into the named volume. Destructive syncs (deleting many files)
 * require `{ confirm: true }` in the body.
 */
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId, volumeName } = await params;
    const appRecord = await verifyAppAccess(orgId, appId);
    if (!appRecord) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = syncSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    const { paths, confirm } = parsed.data;

    // Require confirmation for destructive operations
    if (paths.length >= DESTRUCTIVE_THRESHOLD && !confirm) {
      return NextResponse.json(
        {
          error: `Syncing ${paths.length} files is a destructive operation. Send { confirm: true } to proceed.`,
          requiresConfirmation: true,
          fileCount: paths.length,
        },
        { status: 409 },
      );
    }

    // Load the volume record
    const volume = await db.query.volumes.findFirst({
      where: and(eq(volumes.appId, appId), eq(volumes.name, volumeName)),
    });
    if (!volume) {
      return NextResponse.json({ error: "Volume not found" }, { status: 404 });
    }

    // Get the app's image name
    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, imageName: true, organizationId: true },
    });
    if (!app) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }

    let imageName = app.imageName;
    if (!imageName) {
      try {
        const containers = await listContainers(app.name);
        if (containers.length > 0) {
          imageName = containers[0].image;
        }
      } catch { /* no containers */ }
    }

    if (!imageName) {
      return NextResponse.json(
        { error: "No image available for sync." },
        { status: 400 },
      );
    }

    // Find Docker volume name
    let dockerVolumeName: string | null = null;
    try {
      const containers = await listContainers(app.name);
      for (const container of containers) {
        const info = await inspectContainer(container.id);
        for (const mount of info.mounts) {
          if (mount.destination === volume.mountPath && mount.type === "volume") {
            dockerVolumeName = resolveVolumeName(mount);
            break;
          }
        }
        if (dockerVolumeName) break;
      }
    } catch { /* Docker not available */ }

    if (!dockerVolumeName) {
      return NextResponse.json(
        { error: "Volume is not currently mounted." },
        { status: 400 },
      );
    }

    const result = await syncFilesFromImage(
      imageName,
      dockerVolumeName,
      volume.mountPath,
      paths,
    );

    // Record activity
    recordActivity({
      organizationId: app.organizationId,
      action: "volume.sync",
      appId,
      metadata: {
        volumeName,
        syncedCount: result.synced.length,
        failedCount: result.failed.length,
      },
    }).catch(() => {});

    return NextResponse.json({
      synced: result.synced,
      failed: result.failed,
      summary: {
        requested: paths.length,
        synced: result.synced.length,
        failed: result.failed.length,
      },
    });
  } catch (error) {
    return handleRouteError(error, "Error syncing files from image");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "volumes-sync" });
