// ---------------------------------------------------------------------------
// App lifecycle activity
//
// Server-only half of lib/ui/lifecycle: writes the row when someone restarts,
// stops or starts an app, and reads it back for that app's Deployments tab.
//
// Every writer is an operator path — the HTTP routes and the MCP tools. The
// health monitor's self-heal restart deliberately does not call this; it is a
// response to a symptom and records itself on the stability timeline instead.
// ---------------------------------------------------------------------------

import { and, desc, eq, gte, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { activities, apps } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  buildLifecycleEvents,
  LIFECYCLE_ACTIONS,
  type LifecycleEvent,
  type LifecycleKind,
  type LifecycleScope,
  type LifecycleStatus,
  type LifecycleTrigger,
} from "@/lib/ui/lifecycle";

import { recordActivity } from "./record";

const log = logger.child("lifecycle");

/** How far back the Deployments tab reaches for lifecycle lines. */
export const LIFECYCLE_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

const ROW_LIMIT = 50;

const ACTION_BY_KIND: Record<LifecycleKind, string> = {
  restarted: "app.restarted",
  stopped: "app.stopped",
  started: "app.started",
};

export type LifecycleApp = {
  id: string;
  parentAppId?: string | null;
  composeService?: string | null;
  /** Config waiting on a deploy when the action ran. None of these apply it. */
  needsRedeploy?: boolean | null;
};

/**
 * What the action acted on. A compose child names its service; anything with
 * children of its own is a stack, so one click is not mistaken for one app.
 */
export async function resolveLifecycleScope(
  app: LifecycleApp,
): Promise<{ scope: LifecycleScope; service?: string }> {
  if (app.parentAppId && app.composeService) {
    return { scope: "service", service: app.composeService };
  }
  const child = await db.query.apps.findFirst({
    where: eq(apps.parentAppId, app.id),
    columns: { id: true },
  });
  return { scope: child ? "stack" : "app" };
}

/**
 * Record one operator lifecycle action. Never throws — an audit row that fails
 * to write must not turn a successful restart into an error.
 */
export async function recordLifecycle(opts: {
  organizationId: string;
  app: LifecycleApp;
  kind: LifecycleKind;
  userId?: string;
  trigger?: LifecycleTrigger;
  /** What Docker reported once the command returned, when it could be read. */
  status?: LifecycleStatus | null;
  /** How long the command took. */
  durationMs?: number;
}): Promise<void> {
  try {
    const { scope, service } = await resolveLifecycleScope(opts.app);
    await recordActivity({
      organizationId: opts.organizationId,
      appId: opts.app.id,
      action: ACTION_BY_KIND[opts.kind],
      userId: opts.userId,
      metadata: {
        scope,
        ...(service ? { service } : {}),
        ...(opts.trigger ? { trigger: opts.trigger } : {}),
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.app.needsRedeploy ? { needsRedeploy: true } : {}),
        ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      },
    });
  } catch (err) {
    log.error(`Failed to record app.${opts.kind} for ${opts.app.id}:`, err);
  }
}

/** Lifecycle events for one app's Deployments timeline, newest first. */
export async function loadLifecycleHistory(
  appId: string,
  now = new Date(),
): Promise<LifecycleEvent[]> {
  const since = new Date(now.getTime() - LIFECYCLE_HISTORY_MS);

  const rows = await db.query.activities.findMany({
    where: and(
      eq(activities.appId, appId),
      gte(activities.createdAt, since),
      inArray(activities.action, [...LIFECYCLE_ACTIONS]),
    ),
    orderBy: [desc(activities.createdAt)],
    columns: { id: true, action: true, createdAt: true, metadata: true },
    with: { user: { columns: { name: true, email: true } } },
    limit: ROW_LIMIT,
  });

  return buildLifecycleEvents(rows);
}
