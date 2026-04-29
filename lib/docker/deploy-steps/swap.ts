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
  slotComposeFiles,
  getServicesWithExternalizedVolumes,
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

  // Detect which services we may need to stop in the old slot before the
  // new slot can start. An externalized volume can't be held open by two
  // containers simultaneously, so any service mounting one has to pause
  // during cutover. We compute this early so we can log the rollback plan
  // and short-circuit for first deploys / worker-only stacks.
  const statefulServices = [...getServicesWithExternalizedVolumes(compose)];
  const mustStopOldStateful =
    activeSlot !== null && !isLocalEnv && statefulServices.length > 0;

  // Step 6a: Pre-build and pre-pull new-slot images WITHOUT stopping anything.
  // This is the slowest and most failure-prone phase (dockerfiles can fail,
  // registries can 404, network blips can bite). Doing it before we touch
  // the old slot means the old slot keeps serving if we never get here.
  //
  // Build and pull are complementary, not exclusive: a compose file can mix
  // services that build locally (the user's own app) with services that pull
  // from a registry (sidecars like go2rtc, traefik, postgres). Run both
  // phases — pull only the services that don't have a build directive so we
  // don't ask the registry for an image that compose intends to build.
  const buildServices = Object.entries(compose.services)
    .filter(([, svc]) => svc.build)
    .map(([name]) => name);
  const pullServices = Object.entries(compose.services)
    .filter(([, svc]) => svc.image && !svc.build)
    .map(([name]) => name);
  try {
    if (buildServices.length > 0) {
      log(`[deploy] Pre-building ${newSlot} slot images (old slot still serving)...`);
      const { stdout, stderr } = await execFileAsync(
        "docker",
        ["compose", ...composeFileArgs, "-p", newProjectName, "build", "--progress=plain"],
        { cwd: slotDir, timeout: COMPOSE_BUILD_UP_TIMEOUT }
      );
      for (const line of stdout.split(/\r?\n|\r/).filter(Boolean)) {
        logs.push(`[deploy][build] ${line.trim()}`);
      }
      for (const line of stderr.split(/\r?\n|\r/).filter(Boolean)) {
        logs.push(`[deploy][build] ${line.trim()}`);
      }
    }
    if (pullServices.length > 0) {
      log(`[deploy] Pre-pulling ${newSlot} slot images (old slot still serving)...`);
      const { stdout, stderr } = await execFileAsync(
        "docker",
        ["compose", ...composeFileArgs, "-p", newProjectName, "pull", ...pullServices],
        { cwd: slotDir, timeout: COMPOSE_UP_TIMEOUT }
      );
      for (const line of stdout.split(/\r?\n|\r/).filter(Boolean)) {
        logs.push(`[deploy][pull] ${line.trim()}`);
      }
      for (const line of stderr.split(/\r?\n|\r/).filter(Boolean)) {
        logs.push(`[deploy][pull] ${line.trim()}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Pre-build/pre-pull for ${newSlot} failed (old slot unaffected): ${message}`
    );
  }

  // Step 6b: NOW stop old-slot stateful services. Images are already local,
  // so the window where stateful services are down is as short as possible.
  const oldSlotDir = activeSlot ? join(appDir, activeSlot) : null;
  const oldProjectName = activeSlot
    ? `${app.name}-${ctx.envName}-${activeSlot}`
    : null;
  let oldComposeFileArgsCache: string[] | null = null;
  const getOldComposeFileArgs = async (): Promise<string[]> => {
    if (!oldSlotDir) return [];
    if (oldComposeFileArgsCache) return oldComposeFileArgsCache;
    oldComposeFileArgsCache = await slotComposeFiles(oldSlotDir);
    return oldComposeFileArgsCache;
  };

  // Services we actually stopped — used by the rollback path below to restart
  // them if the new slot fails to come up.
  const stoppedOldServices: string[] = [];

  if (mustStopOldStateful && oldSlotDir && oldProjectName) {
    const oldComposeFileArgs = await getOldComposeFileArgs();

    let oldServiceNames: string[] | null = null;
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["compose", ...oldComposeFileArgs, "-p", oldProjectName, "config", "--services"],
        { cwd: oldSlotDir, timeout: COMPOSE_QUERY_TIMEOUT }
      );
      oldServiceNames = stdout.trim().split("\n").filter(Boolean);
    } catch {
      log(`[deploy] Warning: could not query old slot services — attempting all stateful services`);
    }

    const stoppable = oldServiceNames
      ? statefulServices.filter((s) => new Set(oldServiceNames).has(s))
      : statefulServices;
    const newOnly = oldServiceNames
      ? statefulServices.filter((s) => !new Set(oldServiceNames).has(s))
      : [];

    if (newOnly.length > 0) {
      log(`[deploy] New stateful services (no old-slot equivalent): ${newOnly.join(", ")}`);
    }

    if (stoppable.length > 0) {
      log(`[deploy] Stopping stateful services in old slot: ${stoppable.join(", ")}`);
      const results = await Promise.allSettled(
        stoppable.map((svc) =>
          execFileAsync(
            "docker",
            ["compose", ...oldComposeFileArgs, "-p", oldProjectName, "stop", svc],
            { cwd: oldSlotDir, timeout: COMPOSE_DOWN_TIMEOUT }
          ).then(() => svc)
        )
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          stoppedOldServices.push(result.value);
        } else {
          log(`[deploy] Warning: could not stop old service — ${result.reason instanceof Error ? result.reason.message : result.reason}`);
        }
      }
    }
  }

  // Local helper — restart any old-slot services we stopped, so the old slot
  // keeps serving if the new slot cutover fails. Best-effort; logs but never
  // throws, because we're already in the failure path.
  //
  // We use `up -d --no-recreate --pull never <services>` instead of the more
  // obvious `start`. Reason: `start` only works if the containers still
  // exist, so if anything cleaned them up between the stop and the
  // restore (docker runtime restart, manual ops, system prune), `start`
  // fails silently and the old slot stays dead. `up --no-recreate` will
  // recreate missing containers from the already-present compose files
  // while leaving anything currently running untouched — strict superset
  // of `start` semantics for this use case.
  const restoreOldSlot = async (reason: string) => {
    if (stoppedOldServices.length === 0 || !oldSlotDir || !oldProjectName) return;
    log(`[deploy] Restoring old-slot stateful services after ${reason}: ${stoppedOldServices.join(", ")}`);
    try {
      const oldComposeFileArgs = await getOldComposeFileArgs();
      await execFileAsync(
        "docker",
        [
          "compose",
          ...oldComposeFileArgs,
          "-p", oldProjectName,
          "up", "-d",
          "--no-recreate",
          "--pull", "never",
          ...stoppedOldServices,
        ],
        { cwd: oldSlotDir, timeout: COMPOSE_UP_TIMEOUT }
      );
      // Idempotent: calling restoreOldSlot twice is safe because compose up
      // --no-recreate is a no-op for already-running services.
    } catch (err) {
      log(`[deploy] Warning: failed to restore old-slot stateful services — ${err instanceof Error ? err.message : err}`);
    }
  };

  // Step 7: Start the new slot. Images are already local from Step 6a, so we
  // skip --build and set --pull never to make this deterministic and fast.
  const composeUpTimeout = buildServices.length > 0 ? COMPOSE_BUILD_UP_TIMEOUT : COMPOSE_UP_TIMEOUT;
  log(`[deploy] Starting ${newSlot} slot...`);
  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["compose", ...composeFileArgs, "-p", newProjectName, "up", "-d", "--pull", "never"],
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
    log(`[deploy] Tearing down half-started ${newSlot} slot`);
    await execFileAsync(
      "docker",
      ["compose", ...composeFileArgs, "-p", newProjectName, "down", "--remove-orphans"],
      { cwd: slotDir, timeout: COMPOSE_DOWN_TIMEOUT }
    ).catch(() => {});
    await restoreOldSlot("compose up failure");
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
    await restoreOldSlot("health check failure");
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
