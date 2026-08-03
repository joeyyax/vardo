// ---------------------------------------------------------------------------
// App status reconciliation
//
// apps.status is written only by the deploy engine, so it records what Vardo
// was last told to do rather than what Docker is actually running. An app whose
// container was removed outside Vardo stays "active" forever. This module polls
// Docker and writes the observed state back, including "missing" for a
// registered app with no container at all.
// ---------------------------------------------------------------------------

import pLimit from "p-limit";
import { eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { listAllContainers, inspectContainer, type ContainerInfo } from "./client";
import { logger } from "@/lib/logger";
import { memoryLimitDrifted } from "./limit-drift";
import { composeProjectApp } from "./slot-partition";

const log = logger.child("status-reconcile");

const POLL_INTERVAL_MS = 60_000;
/** Concurrent container inspects while resolving start times. */
const INSPECT_CONCURRENCY = 8;

export type ObservedStatus = "active" | "error" | "stopped" | "missing";

/** An app row as far as container matching is concerned. */
export type ReconcilableApp = {
  id: string;
  name: string;
  status: string;
  parentAppId: string | null;
  composeService: string | null;
  containerName: string | null;
  importedContainerId: string | null;
};

// ---------------------------------------------------------------------------
// Pure matching + decision logic (unit tested)
// ---------------------------------------------------------------------------

function label(c: ContainerInfo, key: string): string | undefined {
  return c.labels[`vardo.${key}`] ?? c.labels[`host.${key}`];
}

/** App the container's compose project belongs to: paperless-staging-green → paperless. */
function projectApp(c: ContainerInfo): string | undefined {
  const project = c.labels["com.docker.compose.project"];
  return project === undefined ? undefined : composeProjectApp(project);
}

/**
 * Containers belonging to an app, most specific match first.
 *
 * Vardo-deployed containers carry vardo.project.id; a decomposed child narrows
 * that set by compose service. Vardo's own control plane is started by plain
 * `docker compose` and carries no vardo labels, so compose project/service and
 * the container name are checked too.
 */
export function matchContainers(app: ReconcilableApp, containers: ContainerInfo[]): ContainerInfo[] {
  if (app.importedContainerId) {
    const imported = containers.filter((c) => c.id === app.importedContainerId);
    if (imported.length > 0) return imported;
  }

  const byAppId = containers.filter((c) => label(c, "project.id") === app.id);
  if (byAppId.length > 0) return byAppId;

  // Decomposed children carry the PARENT's vardo.project.id, so narrow the
  // parent's containers by compose service.
  if (app.parentAppId && app.composeService) {
    const byParent = containers.filter(
      (c) =>
        label(c, "project.id") === app.parentAppId &&
        c.labels["com.docker.compose.service"] === app.composeService,
    );
    if (byParent.length > 0) return byParent;
  }

  if (app.composeService) {
    const byService = containers.filter(
      (c) => c.labels["com.docker.compose.service"] === app.composeService,
    );
    const scoped = byService.filter(
      (c) =>
        label(c, "project") === app.name ||
        projectApp(c) === app.name ||
        `${projectApp(c)}-${app.composeService}` === app.name,
    );
    if (scoped.length > 0) return scoped;
  }

  const byName = containers.filter(
    (c) => c.name === app.containerName || c.name === app.name,
  );
  if (byName.length > 0) return byName;

  const byProject = containers.filter(
    (c) =>
      label(c, "project") === app.name ||
      c.labels["com.docker.compose.project"] === app.name ||
      projectApp(c) === app.name,
  );
  return byProject;
}

/** Exit code embedded in a list-API status string, e.g. "Exited (137) 2 days ago". */
export function parseExitCode(status: string): number | null {
  const m = /^Exited \((\d+)\)/.exec(status);
  return m ? Number(m[1]) : null;
}

/**
 * How long "deploying" is honored before the reconciler takes the status back.
 * Well past the deploy timeout the sweeper enforces, so this only ever catches
 * a status the sweeper could not reset — a process killed mid-deploy.
 */
export const DEPLOYING_HOLD_MS =
  (Number(process.env.DEPLOY_TIMEOUT_MINUTES) || 15) * 60_000 * 4;

/** Whether an in-flight deploy still owns this app's status. */
export function deployHoldsStatus(
  app: { status: string; updatedAt?: Date | null },
  now: Date,
  holdMs: number = DEPLOYING_HOLD_MS,
): boolean {
  if (app.status !== "deploying") return false;
  if (!app.updatedAt) return false;
  return now.getTime() - app.updatedAt.getTime() < holdMs;
}

/**
 * Observed status for one app's containers.
 * "restarting" reads as error — a container flapping is not running.
 */
export function deriveStatus(containers: ContainerInfo[]): ObservedStatus {
  if (containers.length === 0) return "missing";
  if (containers.some((c) => c.state === "restarting" || c.state === "dead")) return "error";
  if (containers.some((c) => c.state === "running")) return "active";
  if (containers.some((c) => (parseExitCode(c.status) ?? 0) !== 0)) return "error";
  return "stopped";
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export async function tickStatusReconcile(): Promise<void> {
  let containers: ContainerInfo[];
  try {
    containers = await listAllContainers();
  } catch (err) {
    log.error("Failed to list containers:", err instanceof Error ? err.message : err);
    return;
  }

  const rows = await db.query.apps.findMany({
    columns: {
      id: true,
      name: true,
      status: true,
      parentAppId: true,
      composeService: true,
      containerName: true,
      importedContainerId: true,
      containerStartedAt: true,
      lastRunningAt: true,
      containerMemoryLimit: true,
      memoryLimit: true,
      needsRedeploy: true,
      updatedAt: true,
    },
  });

  const now = new Date();
  const limit = pLimit(INSPECT_CONCURRENCY);
  const missing: string[] = [];

  const updates = await Promise.all(
    rows.map((app) =>
      limit(async () => {
        // A deploy in flight owns the status until it finishes, or until the
        // hold expires — a stranded "deploying" must not be permanent.
        if (deployHoldsStatus(app, now)) return null;

        const matched = matchContainers(app, containers);
        const observed = deriveStatus(matched);

        let startedAt: Date | null = null;
        let memoryLimit: number | null = null;
        if (observed === "active") {
          const running = matched.find((c) => c.state === "running");
          if (running) {
            try {
              const info = await inspectContainer(running.id);
              const parsed = new Date(info.state.startedAt);
              if (!isNaN(parsed.getTime())) startedAt = parsed;
              memoryLimit = info.memoryBytes;
            } catch {
              // Container went away between list and inspect — keep the old values.
              startedAt = app.containerStartedAt;
              memoryLimit = app.containerMemoryLimit;
            }
          }
        }

        if (observed === "missing" && app.status !== "missing") missing.push(app.name);

        // A configured limit the container is not running is a redeploy away
        // from being real, and nothing else notices the difference.
        const drifted = memoryLimitDrifted(app.memoryLimit, memoryLimit);
        const needsRedeploy = drifted || !!app.needsRedeploy;

        const unchanged =
          observed === app.status &&
          startedAt?.getTime() === app.containerStartedAt?.getTime() &&
          memoryLimit === app.containerMemoryLimit &&
          needsRedeploy === !!app.needsRedeploy;
        return {
          id: app.id,
          touchOnly: unchanged,
          observed,
          startedAt,
          memoryLimit,
          needsRedeploy,
          running: observed === "active",
        };
      }),
    ),
  );

  const settled = updates.filter((u) => u !== null);
  const changed = settled.filter((u) => !u.touchOnly);
  const touched = settled.filter((u) => u.touchOnly);

  for (const u of changed) {
    await db
      .update(apps)
      .set({
        status: u.observed,
        containerStartedAt: u.startedAt,
        containerMemoryLimit: u.memoryLimit,
        needsRedeploy: u.needsRedeploy,
        // Stamped only while running and never cleared, so it survives the
        // container going away. Idle age is measured from this.
        ...(u.running ? { lastRunningAt: now } : {}),
        statusCheckedAt: now,
        updatedAt: now,
      })
      .where(eq(apps.id, u.id));
  }

  const touchedRunning = touched.filter((u) => u.running).map((u) => u.id);
  const touchedIdle = touched.filter((u) => !u.running).map((u) => u.id);

  if (touchedRunning.length > 0) {
    await db
      .update(apps)
      .set({ statusCheckedAt: now, lastRunningAt: now })
      .where(inArray(apps.id, touchedRunning));
  }
  if (touchedIdle.length > 0) {
    await db.update(apps).set({ statusCheckedAt: now }).where(inArray(apps.id, touchedIdle));
  }

  if (missing.length > 0) {
    log.error(
      `${missing.length} registered app(s) have no container on this host: ${missing.join(", ")}`,
    );
  }
  if (changed.length > 0) {
    log.info(`Reconciled ${changed.length} app status(es) against Docker`);
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let interval: NodeJS.Timeout | null = null;
let ticking = false;

export function startStatusReconciler(): void {
  if (interval) return;

  log.info(`Reconciler started (${POLL_INTERVAL_MS / 1000}s interval)`);
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await tickStatusReconcile();
    } catch (err) {
      log.error("Tick error:", err);
    } finally {
      ticking = false;
    }
  };

  // Run once at startup so a stale "active" doesn't survive until the first interval.
  setTimeout(tick, 5_000);
  interval = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopStatusReconciler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Reconciler stopped");
  }
}

function onShutdown(signal: string) {
  log.info(`Received ${signal} — stopping reconciler`);
  stopStatusReconciler();
}

process.once("SIGTERM", () => onShutdown("SIGTERM"));
process.once("SIGINT", () => onShutdown("SIGINT"));
process.once("exit", () => stopStatusReconciler());
