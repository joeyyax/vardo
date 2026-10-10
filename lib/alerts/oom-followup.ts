// Reads an app's state after an OOM kill: status, restarts, limit, peak memory, and what auto-adjust did.

import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { appMemoryAutotune, apps } from "@/lib/db/schema";
import { limitOrigin } from "@/lib/autotune/decide";
import { peakMemory } from "@/lib/autotune/peaks";
import { autotuneAfterOom } from "@/lib/autotune/run";
import { hasGivenUp, recentRestarts } from "@/lib/docker/self-heal-store";
import { logger } from "@/lib/logger";
import { detectHost, loadResourceSettings, tierMemoryMb } from "@/lib/resources/host";
import { getOrgTimeZone } from "@/lib/time-zone-settings";
import type { OomFollowup, OomRecord } from "./oom";

const log = logger.child("alerts");

const HOUR = 60 * 60_000;

async function killedLimit(containerIds: Iterable<string>): Promise<number | null> {
  const { inspectContainer } = await import("@/lib/docker/client");
  for (const id of containerIds) {
    try {
      return (await inspectContainer(id)).memoryBytes;
    } catch {
      // Removed since; try the next.
    }
  }
  return null;
}

/** The follow-up for one record, and auto-adjust's turn on it. Null when the app is gone. */
export async function oomFollowup(record: OomRecord, now: number): Promise<OomFollowup | null> {
  const parents = alias(apps, "oom_parent");
  const [app] = await db
    .select({
      id: apps.id,
      name: apps.name,
      status: apps.status,
      parentAppId: apps.parentAppId,
      composeService: apps.composeService,
      memoryLimit: apps.memoryLimit,
      priority: apps.priority,
      containerStartedAt: apps.containerStartedAt,
      containerRestartCount: apps.containerRestartCount,
      containerMemoryLimit: apps.containerMemoryLimit,
      parentName: parents.name,
      parentPriority: parents.priority,
      appliedMb: appMemoryAutotune.appliedMb,
    })
    .from(apps)
    .leftJoin(parents, eq(parents.id, apps.parentAppId))
    .leftJoin(appMemoryAutotune, eq(appMemoryAutotune.appId, apps.id))
    .where(eq(apps.id, record.appId));
  if (!app) return null;

  await Promise.all([detectHost(), loadResourceSettings()]);
  const [timeZone, peaks, inspected] = await Promise.all([
    getOrgTimeZone(record.organizationId),
    peakMemory([{ id: app.id, name: app.name, parentAppId: app.parentAppId, composeService: app.composeService, parentApp: app.parentName ? { name: app.parentName } : null }], now - HOUR, now),
    killedLimit(record.containerIds).catch(() => null),
  ]);
  const limitBytes = inspected ?? app.containerMemoryLimit ?? null;
  const ids = [...record.containerIds];
  const vardoRestarts = ids.reduce((n, id) => n + recentRestarts(id, now).filter((t) => t >= record.firstAt).length, 0);

  const followup: OomFollowup = {
    status: app.status === "active" ? "running" : ["error", "stopped", "missing"].includes(app.status) ? "down" : "unknown",
    runningSince: app.status === "active" ? app.containerStartedAt : null,
    dockerRestarts:
      record.restartBaseline !== null && app.containerRestartCount !== null
        ? Math.max(0, app.containerRestartCount - record.restartBaseline)
        : null,
    vardoRestarts,
    gaveUp: ids.some((id) => hasGivenUp(id, now)),
    limitBytes,
    limitSource: limitOrigin({
      appLimitMb: app.memoryLimit,
      appliedMb: app.appliedMb ?? null,
      containerLimitBytes: limitBytes,
      tierDefaultMb: tierMemoryMb(app.priority ?? app.parentPriority ?? "standard"),
    }),
    peakBytes: peaks.get(app.id) ?? null,
    timeZone,
  };

  if (record.autotune === undefined) {
    record.autotune = await autotuneAfterOom({
      appId: app.id,
      containerIds: ids,
      limitBytes,
      peakBytes: followup.peakBytes,
      hostKill: record.hostKill,
      now: new Date(now),
    }).catch((err) => {
      log.error(`Auto-adjust failed for ${app.id}:`, err);
      return null;
    });
  }
  return followup;
}
