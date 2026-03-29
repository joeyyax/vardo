import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, volumes } from "@/lib/db/schema";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { eq, and } from "drizzle-orm";
import { computeVolumeDiff } from "@/lib/volumes/diff";
import { listContainers, inspectContainer, resolveVolumeName } from "@/lib/docker/client";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; volumeName: string }>;
};

/**
 * GET — Compare image contents vs volume contents at the mount path.
 *
 * Runs a temp container from the app's current image, generates file lists
 * with checksums from both image and volume, and returns a categorised diff.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId, volumeName } = await params;
    const appRecord = await verifyAppAccess(orgId, appId);
    if (!appRecord) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
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
      columns: { id: true, name: true, imageName: true },
    });
    if (!app) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }

    // Determine the image to diff against
    let imageName = app.imageName;
    if (!imageName) {
      // For built images, try to detect from running container
      try {
        const containers = await listContainers(app.name);
        if (containers.length > 0) {
          imageName = containers[0].image;
        }
      } catch { /* no containers running */ }
    }

    if (!imageName) {
      return NextResponse.json(
        { error: "No image available for diff. Deploy the app first." },
        { status: 400 },
      );
    }

    // Find the Docker volume name from running containers
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
        { error: "Volume is not currently mounted. Deploy the app first." },
        { status: 400 },
      );
    }

    const diff = await computeVolumeDiff(
      imageName,
      dockerVolumeName,
      volume.mountPath,
      volume.ignorePatterns ?? [],
    );

    return NextResponse.json({
      volume: volumeName,
      mountPath: volume.mountPath,
      imageName,
      diff,
      summary: {
        modified: diff.modified.length,
        addedOnDisk: diff.addedOnDisk.length,
        missingFromDisk: diff.missingFromDisk.length,
        ignored: diff.ignored.length,
        totalDrift: diff.modified.length + diff.addedOnDisk.length + diff.missingFromDisk.length,
      },
    });
  } catch (error) {
    return handleRouteError(error, "Error computing volume diff");
  }
}
