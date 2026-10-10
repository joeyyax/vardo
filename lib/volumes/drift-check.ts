import { db } from "@/lib/db";
import { volumes, apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { computeVolumeDiff } from "./diff";
import { liveVolumesOf } from "./reconcile";
import { listContainers, inspectContainer, resolveVolumeName } from "@/lib/docker/client";
import { isAnonymousVolume } from "@/lib/docker/compose";
import { resolveDefaultEnv } from "@/lib/docker/resolve-env";
import { recordActivity } from "@/lib/activity";

const DRIFT_NOTIFICATION_THRESHOLD = 10;

type DriftCheckOpts = {
  appId: string;
  organizationId: string;
  appName: string;
  imageName?: string;
  /** Environment whose containers to inspect. Defaults to the app's default environment. */
  envName?: string;
  log?: (line: string) => void;
};

/** Post-deploy drift check: updates each volume's driftCount and notifies past the threshold. Never throws. */
export async function runPostDeployDriftCheck(opts: DriftCheckOpts): Promise<void> {
  const { appId, organizationId, appName, log } = opts;

  try {
    const appVolumes = await db.query.volumes.findMany({
      where: liveVolumesOf(appId),
    });

    if (appVolumes.length === 0) return;

    // Environments share `vardo.project`; scope to one or other environments' volumes count here.
    const envName = opts.envName ?? (await resolveDefaultEnv(appId)).name;

    let imageName = opts.imageName;
    if (!imageName) {
      const app = await db.query.apps.findFirst({
        where: and(eq(apps.id, appId), eq(apps.organizationId, organizationId)),
        columns: { imageName: true, name: true },
      });
      imageName = app?.imageName ?? undefined;

      if (!imageName) {
        try {
          const containers = await listContainers({ id: appId, name: appName }, envName);
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

    const dockerVolumes = new Map<string, string>(); // mountPath -> dockerVolumeName
    try {
      const containers = await listContainers({ id: appId, name: appName }, envName);
      for (const container of containers) {
        const info = await inspectContainer(container.id);
        for (const mount of info.mounts) {
          if (mount.type === "volume" && !dockerVolumes.has(mount.destination)) {
            const volName = resolveVolumeName(mount);
            if (!isAnonymousVolume(volName)) {
              dockerVolumes.set(mount.destination, volName);
            }
          }
        }
      }
    } catch {
      log?.("[drift] Could not list containers for drift check");
      return;
    }

    let totalDrift = 0;
    const perVolume: { name: string; modified: number; added: number; missing: number }[] = [];

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

        await db
          .update(volumes)
          .set({ driftCount, updatedAt: new Date() })
          .where(eq(volumes.id, vol.id));

        totalDrift += driftCount;

        if (driftCount > 0) {
          perVolume.push({ name: vol.name, modified: diff.modified.length, added: diff.addedOnDisk.length, missing: diff.missingFromDisk.length });
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
          volumes: perVolume,
        });
      } catch {
        // Non-fatal.
      }

      recordActivity({
        organizationId,
        action: "volume.drift_detected",
        appId,
        metadata: { totalDrift },
      }).catch(() => {});
    }
  } catch (err) {
    log?.(

      `[drift] Drift check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
