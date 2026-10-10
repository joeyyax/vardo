// Writes an auto-adjusted memory limit: the app row, the live container, the state row and the activity log.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appMemoryAutotune, apps } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity/record";
import { dockerRequest } from "@/lib/docker/client";
import { logger } from "@/lib/logger";
import { formatBytesIec } from "@/lib/metrics/format";

const log = logger.child("memory-autotune");

const MIB = 1024 * 1024;

type HostConfig = { HostConfig?: { Memory?: number; MemorySwap?: number } };

/** Body for Docker's container update. Keeps the swap allowance above the limit as it was. */
export function memoryUpdateBody(limitBytes: number, current: { memory: number; swap: number }): { Memory: number; MemorySwap?: number } {
  if (current.swap > 0) return { Memory: limitBytes, MemorySwap: limitBytes + Math.max(0, current.swap - current.memory) };
  return { Memory: limitBytes };
}

/** Raises a container's cgroup limit in place. Running or stopped; the next start keeps it. */
async function updateContainerMemory(containerId: string, limitBytes: number): Promise<void> {
  const id = encodeURIComponent(containerId);
  const info = await dockerRequest<HostConfig>("GET", `/containers/${id}/json`);
  const body = memoryUpdateBody(limitBytes, {
    memory: info.HostConfig?.Memory ?? 0,
    swap: info.HostConfig?.MemorySwap ?? 0,
  });
  await dockerRequest("POST", `/containers/${id}/update`, body);
}

export type LimitChange = {
  organizationId: string;
  appId: string;
  appName: string;
  fromMb: number;
  toMb: number;
  direction: "raised" | "lowered";
  /** "after an OOM kill", for the activity log and the Resources tab. */
  reason: string;
  /** Containers to update in place. Lowered limits wait for the next deploy. */
  containerIds: string[];
  /** Raises since the last calm day, including this one. */
  raiseStreak: number;
  now: Date;
};

/** Applies a change and returns whether every container took it live. */
export async function applyLimitChange(change: LimitChange): Promise<boolean> {
  const { now } = change;
  await db.update(apps).set({ memoryLimit: change.toMb, updatedAt: now }).where(eq(apps.id, change.appId));
  const state = {
    appliedMb: change.toMb,
    lastChangedAt: now,
    lastReason: change.reason,
    ...(change.direction === "raised" ? { lastRaisedAt: now, raiseStreak: change.raiseStreak } : {}),
    updatedAt: now,
  };
  await db
    .insert(appMemoryAutotune)
    .values({ appId: change.appId, organizationId: change.organizationId, ...state })
    .onConflictDoUpdate({ target: appMemoryAutotune.appId, set: state });

  let live = change.direction === "raised" && change.containerIds.length > 0;
  if (change.direction === "raised") {
    for (const id of change.containerIds) {
      try {
        await updateContainerMemory(id, change.toMb * MIB);
      } catch (err) {
        live = false;
        log.warn(`Couldn't raise ${id} in place; it applies on the next deploy:`, (err as Error).message);
      }
    }
  }

  const from = formatBytesIec(change.fromMb * MIB);
  const to = formatBytesIec(change.toMb * MIB);
  log.info(`${change.direction === "raised" ? "Raised" : "Lowered"} ${change.appName} from ${from} to ${to} ${change.reason}`);
  try {
    await recordActivity({
      organizationId: change.organizationId,
      appId: change.appId,
      action: change.direction === "raised" ? "app.memory_raised" : "app.memory_lowered",
      metadata: {
        summary: `Memory limit ${change.direction} from ${from} to ${to} ${change.reason}. ${live ? "Applied now." : "Applies on the next deploy."}`,
        fromMb: change.fromMb,
        toMb: change.toMb,
        live,
      },
    });
  } catch (err) {
    log.error(`Failed to record the limit change for ${change.appId}:`, err);
  }
  return live;
}

/** Stops auto-adjust for an app until someone sets its limit. */
export async function haltAutotune(organizationId: string, appId: string, raises: number, now: Date): Promise<void> {
  await db
    .insert(appMemoryAutotune)
    .values({ appId, organizationId, haltedAt: now, raiseStreak: raises, updatedAt: now })
    .onConflictDoUpdate({ target: appMemoryAutotune.appId, set: { haltedAt: now, updatedAt: now } });
  try {
    await recordActivity({
      organizationId,
      appId,
      action: "app.memory_autotune_stopped",
      metadata: { summary: `Auto profile stopped after raising the memory limit ${raises} times without it settling.` },
    });
  } catch (err) {
    log.error(`Failed to record the auto-adjust stop for ${appId}:`, err);
  }
}
