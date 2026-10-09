import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { emit } from "@/lib/notifications/dispatch";
import { inspectContainer } from "@/lib/docker/client";
import { isDataEngine } from "@/lib/docker/routed-service";
import { queryDiskWriteRange } from "./store";
import { formatBytesIec } from "./format";
import { isBulkWriting } from "./bulk-write";
import type { ContainerMetrics } from "./types";
import { logger } from "@/lib/logger";

const log = logger.child("disk-write-alert");

// 1 GiB/hour.
export const DEFAULT_THRESHOLD_BYTES = 1_073_741_824;

// 8 GiB/hour for data engines.
export const DATA_ENGINE_THRESHOLD_BYTES = 8 * 1_073_741_824;

// One alert per container per hour.
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

// containerKey -> last alert timestamp.
const lastAlertTimes = new Map<string, number>();

/** The app's own threshold, else the data engine default, else the general default. */
export function effectiveThreshold(custom: number | null | undefined, dataEngine: boolean): number {
  if (custom) return custom;
  return dataEngine ? DATA_ENGINE_THRESHOLD_BYTES : DEFAULT_THRESHOLD_BYTES;
}

async function isDataEngineContainer(container: ContainerMetrics): Promise<boolean> {
  try {
    const info = await inspectContainer(container.containerIdFull || container.containerId);
    return isDataEngine({ name: container.containerName, image: info.image });
  } catch {
    return false;
  }
}

const APP_COLUMNS = {
  id: true,
  displayName: true,
  organizationId: true,
  parentAppId: true,
  composeService: true,
  diskWriteAlertThreshold: true,
} as const;

/** The app a container belongs to, by labels first and container name second. A stack child wins over its parent. */
async function resolveApp(container: ContainerMetrics) {
  const labelAppId = container.labels["vardo.project.id"] ?? container.labels["host.project.id"] ?? null;
  const service = container.labels["com.docker.compose.service"] ?? null;

  if (labelAppId) {
    if (service) {
      const child = await db.query.apps.findFirst({
        where: and(eq(apps.parentAppId, labelAppId), eq(apps.composeService, service)),
        columns: APP_COLUMNS,
      });
      if (child) return { app: child, labelAppId };
    }
    const app = await db.query.apps.findFirst({ where: eq(apps.id, labelAppId), columns: APP_COLUMNS });
    if (app) return { app, labelAppId };
  }

  const app = await db.query.apps.findFirst({
    where: eq(apps.containerName, container.containerName),
    columns: APP_COLUMNS,
  });
  return { app, labelAppId };
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

      // The lowest threshold any container can have.
      if (writtenInHour <= DEFAULT_THRESHOLD_BYTES) continue;

      try {
        const { app, labelAppId } = await resolveApp(container);

        if (await isBulkWriting([labelAppId, app?.id, app?.parentAppId])) continue;

        const custom = app?.diskWriteAlertThreshold;
        const dataEngine = custom ? false : await isDataEngineContainer(container);
        const threshold = effectiveThreshold(custom, dataEngine);

        if (writtenInHour > threshold) {
          lastAlertTimes.set(alertKey, now);

          const appName = app?.displayName || container.containerName;
          const orgId = app?.organizationId || container.organizationId;

          let parentName: string | undefined;
          if (app?.parentAppId) {
            const parent = await db.query.apps.findFirst({
              where: eq(apps.id, app.parentAppId),
              columns: { displayName: true },
            });
            parentName = parent?.displayName;
          }

          if (orgId) {
            emit(orgId, {
              type: "disk.write-alert",
              title: `High disk writes: ${appName}`,
              message: `App '${appName}' wrote ${formatBytesIec(writtenInHour)} in the last hour (threshold: ${formatBytesIec(threshold)})`,
              appId: app?.id || "",
              appName: app?.displayName,
              projectName: parentName,
              composeService: app?.composeService ?? container.labels["com.docker.compose.service"] ?? undefined,
              dataEngine,
              containerName: container.containerName,
              containerId: container.containerId,
              writtenBytes: writtenInHour,
              thresholdBytes: threshold,
              window: "1h",
            });

            log.warn(
              `${appName} (${container.containerName}): ` +
              `${formatBytesIec(writtenInHour)}/hour exceeds ${formatBytesIec(threshold)} threshold`,
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
