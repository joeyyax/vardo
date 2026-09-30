// ---------------------------------------------------------------------------
// Gathers what Vardo recorded about a stopped container and asks
// intendedStopReason whether that stop was meant.
// ---------------------------------------------------------------------------

import { and, desc, eq, gte, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";
import { appBaseDir, appEnvDir } from "@/lib/paths";
import type { ContainerInfo, ContainerInspect } from "./client";
import { intendedStopReason, projectSlot, type StopIntent } from "./desired-state";
import { readCurrentSlot } from "./standby-slot";
import type { Slot } from "./slots";
import { stopHolder } from "./stop-holds";

export type IntentApp = {
  id: string;
  organizationId: string;
  status: string;
  parked: boolean;
};

/** Newest operator stop on any of these apps since `since`, as epoch ms. */
async function operatorStoppedSince(
  organizationId: string,
  appIds: string[],
  since: number | null,
): Promise<number | null> {
  const row = await db.query.activities.findFirst({
    where: and(
      eq(activities.organizationId, organizationId),
      inArray(activities.appId, appIds),
      eq(activities.action, "app.stopped"),
      gte(activities.createdAt, new Date(since ?? 0)),
    ),
    orderBy: [desc(activities.createdAt)],
    columns: { createdAt: true },
  });
  return row ? row.createdAt.getTime() : null;
}

/** `current` slot for the container's environment, falling back to the legacy unscoped layout. */
async function currentSlotFor(labels: Record<string, string>): Promise<Slot | null> {
  const appName = labels["vardo.project"];
  if (!appName) return null;
  const env = labels["vardo.environment"];
  if (env) {
    const slot = await readCurrentSlot(appEnvDir(appName, env));
    if (slot) return slot;
  }
  return readCurrentSlot(appBaseDir(appName));
}

/** Another container for the same app, environment and service is running. */
export function siblingRunning(
  c: { id: string; labels: Record<string, string> },
  running: ContainerInfo[],
): boolean {
  const key = (l: Record<string, string>) =>
    [l["vardo.project.id"], l["vardo.environment"] ?? "", l["com.docker.compose.service"] ?? ""].join("\0");
  const mine = key(c.labels);
  return running.some((r) => r.id !== c.id && r.state === "running" && key(r.labels) === mine);
}

/**
 * Why this stopped container is meant to stay stopped, or null. Cheap checks
 * run first; the slot symlink and the activity log are read only when needed.
 *
 * `appIds` is every row an operator stop could be recorded on: the app and,
 * for a compose service, its child row.
 */
export async function stopIntentFor(
  info: ContainerInspect,
  app: IntentApp,
  appIds: string[],
  running: ContainerInfo[],
  ownRestart = false,
): Promise<string | null> {
  const started = Date.parse(info.state.startedAt);
  const slot = projectSlot(info.labels["com.docker.compose.project"]);
  const intent: StopIntent = {
    status: info.state.status,
    exitCode: info.state.exitCode,
    restartPolicy: info.restartPolicy,
    startedAt: Number.isFinite(started) && started > 0 ? started : null,
    appStatus: app.status,
    parked: app.parked,
    operatorStoppedAt: null,
    heldBy: stopHolder(info.id),
    slot,
    currentSlot: null,
    siblingRunning: siblingRunning({ id: info.id, labels: info.labels }, running),
  };

  if (slot === "blue" || slot === "green") intent.currentSlot = await currentSlotFor(info.labels);
  const early = intendedStopReason(intent, ownRestart);
  if (early) return early;

  intent.operatorStoppedAt = await operatorStoppedSince(app.organizationId, appIds, intent.startedAt);
  return intendedStopReason(intent, ownRestart);
}
