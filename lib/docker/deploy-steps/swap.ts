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
  getTraefikRoutedServices,
} from "../compose";
import { selectRoutedService } from "../routed-service";
import { prepareBindMountOwnership } from "./bind-mount-ownership";
import { demoteStandbyRestart, restoreSlotRestart } from "../restart-policy";
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
import { classifyComposeServices } from "./classify-services";
import { majorGateAfter, majorGateBefore, type MajorGateState } from "./major-gate";
import { publishesHostPorts } from "../host-ports";
import { partitionBySlot, sharedProjectName, slotScopeArgs } from "../slot-partition";
import { isSelfApp } from "../self-env";
import { clearCutoverPin, guardCutover, type CutoverGuard } from "../traefik-cutover";

const execFileAsync = promisify(execFile);
const NETWORK_NAME = VARDO_NETWORK;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = DEFAULT_HEALTH_CHECK_TIMEOUT;
const HEALTH_CHECK_INTERVAL_MS = 2000;

/** Node kills the child once a stream passes this. A cold build's log is well over the 1MB default. */
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Whether the old slot's stop must wait until every deploy record is written.
 * True only when Vardo is deploying itself and both slots can serve at once.
 */
export function deferSlotStop(canOverlapSlots: boolean, appName: string): boolean {
  return canOverlapSlots && isSelfApp(appName);
}

/**
 * Whether the old slot can be routed away from before it stops.
 *
 * Only when both slots are up, so there is a proven backend to hand the traffic
 * to. The deferred self-deploy pins too: its stop kills this process before the
 * release, leaving the pin behind on the slot that is now serving. Every deploy
 * clears it on the way in, and an instant rollback clears it before flipping.
 */
export function canPinCutover(canOverlapSlots: boolean): boolean {
  return canOverlapSlots;
}

/**
 * Take the old slot out of Traefik, stop it, then hand routing back.
 *
 * The pin is confirmed live before the stop is issued and released after it
 * returns, so no request is ever addressed to a slot that has already gone.
 */
export async function drainThenStop(
  drain: () => Promise<CutoverGuard>,
  stop: () => Promise<void>,
): Promise<void> {
  const guard = await drain();
  try {
    await stop();
  } finally {
    await guard.release();
  }
}

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

  // Services marked x-vardo-shared sit outside the rotation, in their own
  // compose project. Everything below operates on the slotted set only; the
  // shared set is brought up once, further down, and never stopped by a swap.
  const { shared, slotted } = partitionBySlot(compose);
  const sharedNames = Object.keys(shared);
  const slottedNames = Object.keys(slotted);
  const sharedProject = sharedProjectName(app.name, ctx.envName, compose.name);

  const onlySlotted = slotScopeArgs({ shared, slotted });

  // Stop ALL services in the old slot before starting the new one. This
  // prevents port conflicts from any service with host port bindings (not
  // just services with externalized volumes). Without this, services like
  // Redis that expose host ports but don't mount named volumes would keep
  // running, causing "port already allocated" errors in the new slot.
  const mustStopOldSlot = activeSlot !== null && !isLocalEnv;

  // Nothing binds the host, so both slots can run at once. Traefik treats the
  // two as backends of one service and drains to the survivor, which turns the
  // cutover from a gap into an overlap. Anything publishing a port keeps the
  // stop-then-start order — the second bind would fail. Only the rotating
  // services are asked: a shared postgres holds its port across the swap.
  const canOverlapSlots = mustStopOldSlot && !publishesHostPorts(slotted);
  const stopOldBeforeUp = mustStopOldSlot && !canOverlapSlots;

  // Vardo deploying Vardo is the exception: the old slot is running this
  // process, so stopping it here kills the deploy before it records itself.
  // The stop is deferred to the end of post-deploy, once every write is durable.
  const deferStopToPostDeploy = deferSlotStop(canOverlapSlots, app.name);
  const pinCutover = canPinCutover(canOverlapSlots);

  // A pin from a deploy that was killed mid-cutover would hold this app on a
  // slot this deploy is about to replace.
  await clearCutoverPin(app.name, ctx.envName).catch(() => {});

  // Pre-clean the new slot to remove orphaned containers from any previous
  // failed deploy that didn't fully clean up (process crash, timeout, etc.).
  try {
    await execFileAsync(
      "docker",
      ["compose", ...composeFileArgs, "-p", newProjectName, "down", "--remove-orphans"],
      { cwd: slotDir, timeout: COMPOSE_DOWN_TIMEOUT }
    );
  } catch {
    // No containers to clean up — expected on first deploy
  }

  // Step 6a: Pre-build and pre-pull new-slot images WITHOUT stopping anything.
  // This is the slowest and most failure-prone phase (dockerfiles can fail,
  // registries can 404, network blips can bite). Doing it before we touch
  // the old slot means the old slot keeps serving if we never get here.
  //
  // Build and pull are complementary, not exclusive: a compose file can mix
  // services that build locally (the user's own app) with services that pull
  // from a registry (sidecars like go2rtc, traefik, postgres). Run both phases.
  // Images this deploy built locally (ctx.builtImageRefs) are excluded from the
  // pull set — they live only in the local daemon, so pulling them 404s.
  const { buildServices, pullServices } = classifyComposeServices(
    compose.services,
    ctx.builtImageRefs,
  );
  let majorGate: MajorGateState = { candidates: [], before: new Map() };
  try {
    if (buildServices.length > 0) {
      log(`[deploy] Pre-building ${newSlot} slot images (old slot still serving)...`);
      const { stdout, stderr } = await execFileAsync(
        "docker",
        ["compose", "--progress=plain", ...composeFileArgs, "-p", newProjectName, "build"],
        { cwd: slotDir, timeout: COMPOSE_BUILD_UP_TIMEOUT, maxBuffer: EXEC_MAX_BUFFER, signal: ctx.signal }
      );
      for (const line of stdout.split(/\r?\n|\r/).filter(Boolean)) {
        logs.push(`[deploy][build] ${line.trim()}`);
      }
      for (const line of stderr.split(/\r?\n|\r/).filter(Boolean)) {
        logs.push(`[deploy][build] ${line.trim()}`);
      }
    }
    if (pullServices.length > 0) {
      // Read the engine majors off the local images first. After the pull the
      // tag points somewhere else and the old major is unreadable.
      majorGate = await majorGateBefore(ctx, pullServices);
      log(`[deploy] Pre-pulling ${newSlot} slot images (old slot still serving)...`);
      const { stdout, stderr } = await execFileAsync(
        "docker",
        ["compose", ...composeFileArgs, "-p", newProjectName, "pull", ...pullServices],
        { cwd: slotDir, timeout: COMPOSE_UP_TIMEOUT, maxBuffer: EXEC_MAX_BUFFER, signal: ctx.signal }
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

  // A major-locked engine on a tag that names no version can change major on
  // the pull alone. Compared here, where a stop costs nothing: the old slot is
  // still serving and nothing has been replaced.
  await majorGateAfter(ctx, majorGate);

  // Every image this deploy needs now exists locally. Nothing serving has been
  // touched yet, so this is the last point at which a cancel is free.
  ctx.checkAbort();
  ctx.stage("build", "success");
  ctx.stage("deploy", "running");

  // Step 6b: NOW stop old-slot services. Images are already local,
  // so the window where the old slot is down is as short as possible.
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

  // Whether the old slot was pinned to `restart: no`. Tracked apart from the
  // stop, which runs after the demote and can fail on its own.
  let demotedOldSlot = false;

  /** Whether the old slot still runs any of these services. */
  const oldSlotRuns = async (names: string[]): Promise<boolean> => {
    if (!oldSlotDir || !oldProjectName) return false;
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["compose", ...(await getOldComposeFileArgs()), "-p", oldProjectName, "ps", "-q", ...names],
        { cwd: oldSlotDir, timeout: COMPOSE_QUERY_TIMEOUT },
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  };

  let stoppedOldSlot = false;

  const stopOldSlot = async () => {
    if (!oldSlotDir || !oldProjectName || stoppedOldSlot) return;
    stoppedOldSlot = true;
    const oldComposeFileArgs = await getOldComposeFileArgs();
    log(`[deploy] Stopping old slot (${activeSlot})...`);

    const stop = async () => {
      try {
        // Demote before stopping, not after — when the old slot is running this
        // process there is no "after". Never move this below the stop.
        demotedOldSlot = true;
        await demoteStandbyRestart(oldComposeFileArgs, oldProjectName, oldSlotDir);
        // `stop`, not `down` — the old slot stays as a warm standby, keeping its
        // containers and their logs for rollback. It is removed by the pre-clean
        // above on the next deploy that reuses this slot dir.
        await execFileAsync(
          "docker",
          ["compose", ...oldComposeFileArgs, "-p", oldProjectName, "stop"],
          { cwd: oldSlotDir, timeout: COMPOSE_DOWN_TIMEOUT }
        );
        stoppedOldServices.push("__all__");
      } catch (err) {
        log(`[deploy] Warning: could not stop old slot — ${err instanceof Error ? err.message : err}`);
      }
    };

    if (!pinCutover) {
      await stop();
      return;
    }

    await drainThenStop(
      () =>
        guardCutover({
          appName: app.name,
          envName: ctx.envName,
          compose,
          slotted,
          newProjectName,
          oldProjectName,
          log,
        }),
      stop,
    );
  };

  // An app last deployed before a service stopped rotating still runs it in the
  // old slot, on the volume the shared project is about to claim. Nothing may
  // overlap that, so the old slot goes down first — the same order a published
  // host port forces. Only ever the first deploy after the service left the
  // rotation; Vardo's own shared services carry container_name and have never
  // been in a slot project, so the deferred self-deploy is left alone.
  const oldSlotHoldsShared =
    mustStopOldSlot && !deferStopToPostDeploy && sharedNames.length > 0
      ? await oldSlotRuns(sharedNames)
      : false;

  if (stopOldBeforeUp || oldSlotHoldsShared) {
    if (oldSlotHoldsShared) {
      log(`[deploy] Old slot still runs ${sharedNames.join(", ")} — stopping it before the shared project starts`);
    }
    await stopOldSlot();
  } else if (canOverlapSlots) {
    log(`[deploy] No published host ports — ${activeSlot} keeps serving until ${newSlot} is healthy`);
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
  //
  // Reached whenever the old slot was demoted, not only when it was stopped.
  const restoreOldSlot = async (reason: string) => {
    if (!oldSlotDir || !oldProjectName) return;
    if (stoppedOldServices.length === 0 && !demotedOldSlot) return;
    const serviceNames = stoppedOldServices.filter((s) => s !== "__all__");
    log(`[deploy] Restoring old-slot services after ${reason}: ${serviceNames.length > 0 ? serviceNames.join(", ") : "all"}`);
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
          ...(sharedNames.length > 0 ? ["--no-deps"] : []),
          ...(serviceNames.length > 0 ? serviceNames : slottedNames),
        ],
        { cwd: oldSlotDir, timeout: COMPOSE_UP_TIMEOUT }
      );
      // It is serving again, so it needs its own restart policy back.
      await restoreSlotRestart(oldComposeFileArgs, oldProjectName, oldSlotDir);
      // Idempotent: calling restoreOldSlot twice is safe because compose up
      // --no-recreate is a no-op for already-running services.
    } catch (err) {
      log(`[deploy] Warning: failed to restore old-slot services — ${err instanceof Error ? err.message : err}`);
    }
  };

  // Step 6b2: Bring up the shared services. --no-recreate means an already
  // running database is left exactly as it is; only a missing one is created.
  // Runs before the new slot so anything depending on it can connect.
  if (sharedNames.length > 0) {
    log(`[deploy] Shared services (not rotated): ${sharedNames.join(", ")}`);
    try {
      const { stdout, stderr } = await execFileAsync(
        "docker",
        [
          "compose",
          ...composeFileArgs,
          "-p", sharedProject,
          "up", "-d",
          "--no-recreate",
          "--no-deps",
          ...sharedNames,
        ],
        { cwd: slotDir, timeout: COMPOSE_UP_TIMEOUT, maxBuffer: EXEC_MAX_BUFFER }
      );
      for (const line of `${stdout}\n${stderr}`.split(/\r?\n|\r/).filter(Boolean)) {
        logs.push(`[deploy][shared] ${line.trim()}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Shared services failed to start (old slot unaffected): ${message}`);
    }
  }

  // Step 6c: Pre-create and chown bind-mount targets to each service's non-root
  // uid. Without this, the daemon creates missing host paths root-owned and
  // non-root containers can't write under them (#738). Runs after images exist
  // (Step 6a) so the uid can be read from them, and before compose up.
  await prepareBindMountOwnership(ctx);

  // Step 7: Start the new slot. Images are already local from Step 6a, so we
  // skip --build and set --pull never to make this deterministic and fast.
  const composeUpTimeout = buildServices.length > 0 ? COMPOSE_BUILD_UP_TIMEOUT : COMPOSE_UP_TIMEOUT;
  log(`[deploy] Starting ${newSlot} slot...`);
  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["compose", ...composeFileArgs, "-p", newProjectName, "up", "-d", "--pull", "never", ...onlySlotted],
      { cwd: slotDir, timeout: composeUpTimeout, maxBuffer: EXEC_MAX_BUFFER }
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

  // Probe the container Traefik was pointed at; a probe against the wrong
  // container fails open and reports the deploy healthy.
  const routed = getTraefikRoutedServices(compose);
  const routedName =
    [...routed][0] ?? selectRoutedService(compose, { containerPort }).service;
  // A shared routed service is never replaced, so the deploy would prove
  // nothing. Validation rejects it on save; this catches apps saved earlier.
  const primarySvcName = sharedNames.includes(routedName) ? undefined : routedName;
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
        { cwd: slotDir, timeout: COMPOSE_QUERY_TIMEOUT, maxBuffer: EXEC_MAX_BUFFER }
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

  // Both slots have been serving since the new one came up. Drop the old one
  // now that the new one is proven, so the cutover never leaves a gap.
  if (canOverlapSlots && !deferStopToPostDeploy) {
    await stopOldSlot();
  }
  ctx.stopOldSlot = deferStopToPostDeploy ? stopOldSlot : undefined;

  // Step 9: Update container names in DB
  if (!isLocalEnv) {
    try {
      const serviceNames = Object.keys(compose.services);
      // A shared service keeps its own project name; only slotted ones move.
      const projectFor = (svc: string) =>
        sharedNames.includes(svc) ? sharedProject : newProjectName;
      const primaryServiceName = slottedNames[0] ?? serviceNames[0];

      if (primaryServiceName) {
        const parentContainerName = `${projectFor(primaryServiceName)}-${primaryServiceName}-1`;
        await db
          .update(apps)
          .set({ containerName: parentContainerName, updatedAt: new Date() })
          .where(eq(apps.id, ctx.appId));
        log(`[deploy] Updated container name: ${parentContainerName}`);
      }

      if (serviceNames.length > 1) {
        for (const serviceName of serviceNames) {
          const childContainerName = `${projectFor(serviceName)}-${serviceName}-1`;
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
