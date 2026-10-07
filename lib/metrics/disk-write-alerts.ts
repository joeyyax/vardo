import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { emit } from "@/lib/notifications/dispatch";
import { queryDiskWriteRange } from "./store";
import type { ContainerMetrics } from "./types";
import { logger } from "@/lib/logger";

const log = logger.child("disk-write-alert");

// 1 GB/hour.
const DEFAULT_THRESHOLD_BYTES = 1_073_741_824;

// One alert per container per hour.
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

// containerKey -> last alert timestamp.
const lastAlertTimes = new Map<string, number>();

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + " GB";
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + " MB";
  return (bytes / 1024).toFixed(1) + " KB";
}

function formatThreshold(bytes: number): string {
  if (bytes >= 1_073_741_824) {
    const gb = bytes / 1_073_741_824;
    return Number.isInteger(gb) ? gb + " GB" : gb.toFixed(1) + " GB";
  }
  if (bytes >= 1_048_576) {
    const mb = bytes / 1_048_576;
    return Number.isInteger(mb) ? mb + " MB" : mb.toFixed(1) + " MB";
  }
  return (bytes / 1024).toFixed(0) + " KB";
}

/** Alerts when a container's disk writes over the last hour exceed its app's threshold. Never blocks. */
export async function checkDiskWriteAlerts(
  metrics: ContainerMetrics[],
): Promise<void> {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  const projectContainers = new Map<string, ContainerMetrics[]>();
  for (const m of metrics) {
    if (!m.projectName) continue;
    const list = projectContainers.get(m.projectName) || [];
    list.push(m);
    projectContainers.set(m.projectName, list);
  }

  for (const [projectName, containers] of projectContainers) {
    for (const container of containers) {
      const alertKey = `${projectName}:${container.containerId}`;

      const lastAlert = lastAlertTimes.get(alertKey);
      if (lastAlert && now - lastAlert < ALERT_COOLDOWN_MS) continue;

      const points = await queryDiskWriteRange(
        projectName,
        container.containerId,
        oneHourAgo,
        now,
      );

      if (points.length < 2) continue;

      const oldest = points[0][1];
      const newest = points[points.length - 1][1];
      const writtenInHour = newest - oldest;

      if (writtenInHour <= 0) continue;

      let threshold = DEFAULT_THRESHOLD_BYTES;
      try {
        // Match by containerName first, then project name.
        const app = await db.query.apps.findFirst({
          where: eq(apps.containerName, container.containerName),
          columns: {
            id: true,
            displayName: true,
            organizationId: true,
            diskWriteAlertThreshold: true,
            templateName: true,
          },
        });

        if (app?.diskWriteAlertThreshold) {
          threshold = app.diskWriteAlertThreshold;
        }

        if (writtenInHour > threshold) {
          lastAlertTimes.set(alertKey, now);

          const appName = app?.displayName || container.containerName;
          const orgId = app?.organizationId || container.organizationId;

          if (orgId) {
            emit(orgId, {
              type: "disk.write-alert",
              title: `High disk writes: ${appName}`,
              message: `App '${appName}' wrote ${formatBytes(writtenInHour)} in the last hour (threshold: ${formatThreshold(threshold)})`,
              appId: app?.id || "",
              containerName: container.containerName,
              containerId: container.containerId,
              writtenBytes: writtenInHour,
              thresholdBytes: threshold,
              window: "1h",
            });

            log.warn(
              `${appName} (${container.containerName}): ` +
              `${formatBytes(writtenInHour)}/hour exceeds ${formatThreshold(threshold)} threshold`,
            );
          }
        }
      } catch (err) {
        log.error(
          `Error checking ${container.containerName}:`,
          (err as Error).message,
        );
      }
    }
  }
}
