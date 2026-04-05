// ---------------------------------------------------------------------------
// Deploy Steps 6-9: Network setup, old slot teardown, compose up,
// health check, and container name update.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { ensureNetwork } from "../client";
import {
  isAnonymousVolume,
  slotComposeFiles,
} from "../compose";
import {
  NETWORK_NAME as VARDO_NETWORK,
  DEFAULT_HEALTH_CHECK_TIMEOUT,
  POST_DEPLOY_DELAY,
  COMPOSE_DOWN_TIMEOUT,
  COMPOSE_UP_TIMEOUT,
  COMPOSE_BUILD_UP_TIMEOUT,
  COMPOSE_QUERY_TIMEOUT,
  HTTP_PROBE_TIMEOUT,
} from "../constants";
import type { DeployContext } from "../deploy-context";

const execFileAsync = promisify(execFile);
const NETWORK_NAME = VARDO_NETWORK;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = DEFAULT_HEALTH_CHECK_TIMEOUT;
const HEALTH_CHECK_INTERVAL_MS = 2000;

/**
 * Parse a Docker duration string (e.g. "1m", "30s", "1m30s", "500ms") to milliseconds.
 */
function parseDuration(d: string | undefined): number {
  if (!d) return 0;
  let ms = 0;
  const parts = d.match(/(\d+)(ms|s|m|h)/g);
  if (!parts) return 0;
  for (const part of parts) {
    const match = part.match(/^(\d+)(ms|s|m|h)$/);
    if (!match) continue;
    const val = parseInt(match[1], 10);
    switch (match[2]) {
      case "ms": ms += val; break;
      case "s": ms += val * 1000; break;
      case "m": ms += val * 60000; break;
      case "h": ms += val * 3600000; break;
    }
  }
  return ms;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealthy(
  projectName: string,
  composeFileArgs: string[],
  cwd: string,
  logs: { push: (line: string) => void },
  timeoutMs: number = DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  httpProbe?: { containerName: string; port: number },
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let httpProbeNeeded = false;

  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["compose", ...composeFileArgs, "-p", projectName, "ps", "--format", "json"],
        { cwd, timeout: COMPOSE_QUERY_TIMEOUT }
      );

      const lines = stdout.trim().split("\n").filter(Boolean);
      if (lines.length === 0) {
        await sleep(HEALTH_CHECK_INTERVAL_MS);
        continue;
      }

      let allReady = true;
      httpProbeNeeded = false;
      for (const line of lines) {
        try {
          const container = JSON.parse(line);
          const state = (container.State || "").toLowerCase();
          const health = (container.Health || "").toLowerCase();

          if (state === "exited" || state === "dead") {
            logs.push(`[health] ${container.Service || container.Name}: ${state}`);
            return false;
          }

          if (health && health !== "healthy") {
            allReady = false;
          } else if (!health && state === "running") {
            httpProbeNeeded = true;
          } else if (!health && state !== "running") {
            allReady = false;
          }
        } catch { /* skip */ }
      }

      if (allReady && httpProbeNeeded && httpProbe) {
        try {
          const probeUrl = `http://${httpProbe.containerName}:${httpProbe.port}/`;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), HTTP_PROBE_TIMEOUT);
          const res = await fetch(probeUrl, {
            signal: controller.signal,
            redirect: "manual",
          });
          clearTimeout(timer);
          if (res.status > 0) return true;
        } catch {
          // HTTP probe failed — for non-HTTP services (databases, caches, etc.)
          // a running container without a Docker healthcheck is considered healthy.
          // Only keep retrying if the container explicitly declares a healthcheck.
          return true;
        }
      } else if (allReady) {
        return true;
      }
    } catch { /* retry */ }

    await sleep(HEALTH_CHECK_INTERVAL_MS);
  }

  logs.push(`[health] Timeout after ${timeoutMs / 1000}s`);
  return false;
}

export async function swap(ctx: DeployContext): Promise<DeployContext> {
  const { app, log, logs, compose, composeFileArgs, activeSlot, newSlot, slotDir, newProjectName, isLocalEnv, containerPort } = ctx;
  const appDir = ctx.appDir;

  // Step 6: Ensure network
  try {
    await ensureNetwork(NETWORK_NAME);
  } catch (err) {
    log(`[deploy] Warning: network — ${err instanceof Error ? err.message : err}`);
  }

  // Step 6b: Stop old-slot stateful services that mount externalized volumes
  if (activeSlot && !isLocalEnv && compose.volumes && Object.keys(compose.volumes).length > 0) {
    const externalVolumeNames = new Set(
      Object.keys(compose.volumes).filter((v) => !isAnonymousVolume(v))
    );

    const statefulServices: string[] = [];
    for (const [svcName, svc] of Object.entries(compose.services)) {
      const mounts = svc.volumes ?? [];
      const usesExternalVol = mounts.some((m) => {
        const src = m.split(":")[0];
        return externalVolumeNames.has(src);
      });
      if (usesExternalVol) statefulServices.push(svcName);
    }

    if (statefulServices.length > 0) {
      const oldSlotDir = join(appDir, activeSlot);
      const oldProjectName = `${app.name}-${ctx.envName}-${activeSlot}`;
      const oldComposeFileArgs = await slotComposeFiles(oldSlotDir);
      log(`[deploy] Stopping stateful services in old slot: ${statefulServices.join(", ")}`);
      try {
        await execFileAsync(
          "docker",
          ["compose", ...oldComposeFileArgs, "-p", oldProjectName, "stop", ...statefulServices],
          { cwd: oldSlotDir, timeout: COMPOSE_DOWN_TIMEOUT }
        );
      } catch (err) {
        log(`[deploy] Warning: could not stop old stateful services — ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Step 7: Pull and start new slot
  const hasBuild = Object.values(compose.services).some((svc) => svc.build);
  const pullPolicy = ctx.builtLocally || hasBuild ? "missing" : "always";
  const composeUpTimeout = hasBuild ? COMPOSE_BUILD_UP_TIMEOUT : COMPOSE_UP_TIMEOUT;
  log(`[deploy] Starting ${newSlot} slot...`);
  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["compose", ...composeFileArgs, "-p", newProjectName, "up", "-d", ...(hasBuild ? ["--build"] : []), "--pull", pullPolicy],
      { cwd: slotDir, timeout: composeUpTimeout }
    );
    for (const line of stdout.split(/\r?\n|\r/).filter(Boolean)) {
      logs.push(`[deploy][compose] ${line.trim()}`);
    }
    for (const line of stderr.split(/\r?\n|\r/).filter(Boolean)) {
      logs.push(`[deploy][compose] ${line.trim()}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`docker compose up (${newSlot}) failed: ${message}`);
  }

  // Step 8: Health check
  ctx.checkAbort();
  ctx.stage("deploy", "success");
  ctx.stage("healthcheck", "running");
  log(`[deploy] Waiting for ${newSlot} to be healthy...`);

  let healthTimeoutMs = (app.healthCheckTimeout ?? 0) * 1000 || DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  if (!app.healthCheckTimeout) {
    for (const svc of Object.values(compose.services)) {
      if (svc.healthcheck) {
        const interval = parseDuration(svc.healthcheck.interval);
        const startPeriod = parseDuration(svc.healthcheck.start_period);
        const retries = svc.healthcheck.retries ?? 3;
        const needed = startPeriod + (interval * retries) + POST_DEPLOY_DELAY;
        if (needed > healthTimeoutMs) {
          healthTimeoutMs = needed;
          log(`[deploy] Extended health timeout to ${Math.round(needed / 1000)}s (service healthcheck interval: ${svc.healthcheck.interval || "default"})`);
        }
      }
    }
  }

  const primarySvcName = Object.keys(compose.services).find(
    (k) => !compose.services[k].network_mode || compose.services[k].network_mode === "bridge"
  );
  const httpProbe = primarySvcName
    ? { containerName: `${newProjectName}-${primarySvcName}-1`, port: containerPort }
    : undefined;

  const healthy = await waitForHealthy(newProjectName, composeFileArgs, slotDir, logs, healthTimeoutMs, httpProbe);
  if (!healthy) {
    log(`[deploy] Health check failed — fetching container logs...`);
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["compose", ...composeFileArgs, "-p", newProjectName, "logs", "--tail", "30"],
        { cwd: slotDir, timeout: COMPOSE_QUERY_TIMEOUT }
      );
      if (stdout.trim()) {
        for (const line of stdout.trim().split("\n")) {
          log(`[deploy][crash] ${line}`);
        }
      }
    } catch { /* couldn't get logs */ }

    log(`[deploy] Tearing down ${newSlot}`);
    await execFileAsync(
      "docker",
      ["compose", ...composeFileArgs, "-p", newProjectName, "down", "--remove-orphans"],
      { cwd: slotDir, timeout: COMPOSE_DOWN_TIMEOUT }
    ).catch(() => {});
    throw new Error(`${newSlot} slot did not become healthy — container may have crashed (see logs above)`);
  }
  ctx.stage("healthcheck", "success");
  ctx.stage("routing", "running");
  log(`[deploy] ${newSlot} healthy`);

  // Step 9: Update container names in DB
  if (!isLocalEnv) {
    try {
      const serviceNames = Object.keys(compose.services);
      const primaryServiceName = serviceNames[0];

      if (primaryServiceName) {
        const parentContainerName = `${newProjectName}-${primaryServiceName}-1`;
        await db
          .update(apps)
          .set({ containerName: parentContainerName, updatedAt: new Date() })
          .where(eq(apps.id, ctx.appId));
        log(`[deploy] Updated container name: ${parentContainerName}`);
      }

      if (serviceNames.length > 1) {
        for (const serviceName of serviceNames) {
          const childContainerName = `${newProjectName}-${serviceName}-1`;
          const childName = `${app.name}-${serviceName}`;
          await db
            .update(apps)
            .set({ containerName: childContainerName, updatedAt: new Date() })
            .where(and(eq(apps.parentAppId, ctx.appId), eq(apps.name, childName)));
        }
      }
    } catch (err) {
      log(`[deploy] Warning: failed to update container names — ${err instanceof Error ? err.message : err}`);
    }
  }

  log(`[deploy] Traffic routed to ${newSlot}`);
  ctx.stage("routing", "success");

  return ctx;
}
