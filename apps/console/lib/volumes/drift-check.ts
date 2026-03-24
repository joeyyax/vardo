import { db } from "@/lib/db";
import { volumes, apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { computeVolumeDiff } from "./diff";
import { listContainers, inspectContainer } from "@/lib/docker/client";
import { recordActivity } from "@/lib/activity";

const DRIFT_NOTIFICATION_THRESHOLD = 10;

type DriftCheckOpts = {
  appId: string;
  organizationId: string;
  appName: string;
  imageName?: string;
  log?: (line: string) => void;
};

/**
 * Run a post-deploy drift check on all volumes for an app.
 * Updates driftCount on each volume record. Fires a notification
 * if unignored drift exceeds the threshold.
 *
 * This is designed to run in the background after deploy completes
 * and should never throw — all errors are caught internally.
 */
export async function runPostDeployDriftCheck(opts: DriftCheckOpts): Promise<void> {
  const { appId, organizationId, appName, log } = opts;

  try {
    // Load all volumes for this app
    const appVolumes = await db.query.volumes.findMany({
      where: eq(volumes.appId, appId),
    });

    if (appVolumes.length === 0) return;

    // Determine image name
    let imageName = opts.imageName;
    if (!imageName) {
      const app = await db.query.apps.findFirst({
        where: and(eq(apps.id, appId), eq(apps.organizationId, organizationId)),
        columns: { imageName: true, name: true },
      });
      imageName = app?.imageName ?? undefined;

      if (!imageName) {
        try {
          const containers = await listContainers(appName);
          if (containers.length > 0) {
            imageName = containers[0].image;
          }
        } catch { /* no containers */ }
      }
    }

    if (!imageName) {
      log?.("[drift] No image available for drift check");
      return;
    }

    // Find Docker volume names from running containers
    const dockerVolumes = new Map<string, string>(); // mountPath -> dockerVolumeName
    try {
      const containers = await listContainers(appName);
      for (const container of containers) {
        const info = await inspectContainer(container.id);
        for (const mount of info.mounts) {
          if (mount.type === "volume" && !dockerVolumes.has(mount.destination)) {
            const volName = mount.source.split("/").pop() || mount.source;
            dockerVolumes.set(mount.destination, volName);
          }
        }
      }
    } catch {
      log?.("[drift] Could not list containers for drift check");
      return;
    }

    let totalDrift = 0;

    for (const vol of appVolumes) {
      const dockerVolumeName = dockerVolumes.get(vol.mountPath);
      if (!dockerVolumeName) continue;

      try {
        const diff = await computeVolumeDiff(
          imageName,
          dockerVolumeName,
          vol.mountPath,
          vol.ignorePatterns ?? [],
        );

        const driftCount =
          diff.modified.length + diff.addedOnDisk.length + diff.missingFromDisk.length;

        // Update drift count on the volume record
        await db
          .update(volumes)
          .set({ driftCount, updatedAt: new Date() })
          .where(eq(volumes.id, vol.id));

        totalDrift += driftCount;

        if (driftCount > 0) {
          log?.(
            `[drift] Volume '${vol.name}': ${driftCount} unignored change(s) (${diff.modified.length} modified, ${diff.addedOnDisk.length} added, ${diff.missingFromDisk.length} missing)`,
          );
        }
      } catch (err) {
        log?.(
          `[drift] Error checking volume '${vol.name}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Fire notification if drift exceeds threshold
    if (totalDrift >= DRIFT_NOTIFICATION_THRESHOLD) {
      try {
        const { emit } = await import("@/lib/notifications/dispatch");
        emit(organizationId, {
          type: "volume.drift",
          title: `Volume drift detected: ${appName}`,
          message: `${totalDrift} unignored file change(s) detected across volumes after deploy. Review in the Volumes panel.`,
          appId,
          appName,
          totalDrift,
        });
      } catch {
        // Notification module may not exist yet — non-fatal
      }

      recordActivity({
        organizationId,
        action: "volume.drift_detected",
        appId,
        metadata: { totalDrift },
      }).catch(() => {});
    }
  } catch (err) {
    // Entire drift check is best-effort
    log?.(
      `[drift] Drift check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
