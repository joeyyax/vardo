// Deploy steps 6-9: network, old-slot stop, compose up, health check and container names.

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { join } from "path";
import { connect } from "net";
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
import type { DeployContext, SlotStopOutcome } from "../deploy-context";
import { classifyComposeServices } from "./classify-services";
import type { ComposeService } from "../compose-types";
import { sharedPullTargets } from "./shared-images";
import { describeSharedOutcome, reconcileSharedServices, SharedRecreateError } from "./shared-drift";
import { majorGateAfter, majorGateBefore, type MajorGateState } from "./major-gate";
import { publishesHostPorts } from "../host-ports";
import { getServicesWithExternalizedVolumes } from "../compose-inject";
import { registryAuthHint, withRegistryAuth } from "../registry-auth";
import { partitionBySlot, sharedProjectName, slotOverlapDiagnosis, slotScopeArgs } from "../slot-partition";
import { isSelfApp } from "../self-env";
import { clearCutoverPin, guardCutover, type CutoverGuard } from "../traefik-cutover";
import { projectScopedNetworkNames } from "../shared-networks";
import { overlapFitsNow } from "../memory-headroom";
import { reportOomDuringDeploy } from "../deploy-oom";
import { checkVolumeLimits } from "./volume-limits";
import { execFileAsync } from "@/lib/utils/exec";
import { boundedBuild, explainBuildOom } from "../build-memory";
import { dockerEnv } from "@/lib/docker/docker-env";
import { exportMsFromBuildOutput } from "../stage-timings";

const NETWORK_NAME = VARDO_NETWORK;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = DEFAULT_HEALTH_CHECK_TIMEOUT;
const HEALTH_CHECK_INTERVAL_MS = 2000;

/** Cold build logs exceed Node's 1MB default, which kills the child. */
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Whether the old slot's stop must wait until every deploy record is written.
 * True only when Vardo is deploying itself and both slots can serve at once.
 */
export function deferSlotStop(canOverlapSlots: boolean, appName: string): boolean {
  return canOverlapSlots && isSelfApp(appName);
}

/**
 * Whether the old slot can be routed away from before it stops: only when both slots are up.
 * A self-deploy leaves its pin behind; the next deploy or instant rollback clears it.
 */
export function canPinCutover(canOverlapSlots: boolean): boolean {
  return canOverlapSlots;
}

/** Pin Traefik away from the old slot, stop it, then release the pin. */
export async function drainThenStop<T>(
  drain: () => Promise<CutoverGuard>,
  stop: () => Promise<T>,
): Promise<T> {
  const guard = await drain();
  try {
    return await stop();
  } finally {
    await guard.release();
  }
}

/** Docker's way of saying the containers this asked to stop are already gone. */
function alreadyGone(message: string): boolean {
  return /no such container|no container found for project/i.test(message);
}

/** Docker duration ("1m30s", "500ms") to milliseconds. */
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

/** How long a recreated shared service gets to report ready. */
export function sharedReadyTimeout(service: ComposeService): number {
  const hc = service.healthcheck;
  if (!hc || hc.disable) return DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  const needed =
    parseDuration(hc.start_period) + (parseDuration(hc.interval) || 30_000) * (hc.retries ?? 3) + POST_DEPLOY_DELAY;
  return Math.max(DEFAULT_HEALTH_CHECK_TIMEOUT_MS, needed);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long a service without a Docker healthcheck must stay ready in a row. */
export const HEALTH_STABLE_WINDOW_MS = 6_000;

/** Resolves true when the service accepts a connection. */
export type ReadinessProbe = () => Promise<boolean>;

/** A TCP connect to `host:port`. */
export function tcpProbe(host: string, port: number, timeoutMs = HTTP_PROBE_TIMEOUT): ReadinessProbe {
  return () =>
    new Promise((resolve) => {
      const socket = connect({ host, port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
}

/** The port Traefik sends a service's traffic to, when its labels name one. */
export function routedPort(service: ComposeService | undefined): number | null {
  const labels = service?.labels;
  if (!labels) return null;
  for (const [key, value] of Object.entries(labels)) {
    if (!/^traefik\.http\.services\.[^.]+\.loadbalancer\.server\.port$/i.test(key)) continue;
    const port = Number(value);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return null;
}

/**
 * Wait for the new slot to be ready; a timeout fails. Healthchecked services must be healthy;
 * others must stay running, with the probe passing, for HEALTH_STABLE_WINDOW_MS.
 */
export async function waitForHealthy(
  projectName: string,
  composeFileArgs: string[],
  cwd: string,
  logs: { push: (line: string) => void },
  timeoutMs: number = DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  probe?: ReadinessProbe,
  timing: { intervalMs?: number; stableMs?: number } = {},
): Promise<boolean> {
  const intervalMs = timing.intervalMs ?? HEALTH_CHECK_INTERVAL_MS;
  const stableMs = timing.stableMs ?? HEALTH_STABLE_WINDOW_MS;
  const deadline = Date.now() + timeoutMs;
  let readySince: number | null = null;
  let waitingOn = "no containers yet";

  while (Date.now() < deadline) {
    let ready = false;
    let needsWindow = false;
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["compose", ...composeFileArgs, "-p", projectName, "ps", "--format", "json"],
        { env: dockerEnv(), cwd, timeout: COMPOSE_QUERY_TIMEOUT }
      );

      const lines = stdout.trim().split("\n").filter(Boolean);
      ready = lines.length > 0;
      for (const line of lines) {
        let container: { State?: string; Health?: string; Service?: string; Name?: string };
        try {
          container = JSON.parse(line);
        } catch {
          ready = false;
          continue;
        }
        const name = container.Service || container.Name || "container";
        const state = (container.State || "").toLowerCase();
        const health = (container.Health || "").toLowerCase();

        if (state === "exited" || state === "dead") {
          logs.push(`[health] ${name}: ${state}`);
          return false;
        }

        if (health) {
          if (health !== "healthy") {
            ready = false;
            waitingOn = `${name} is ${health}`;
          }
        } else if (state !== "running") {
          ready = false;
          waitingOn = `${name} is ${state || "not running"}`;
        } else {
          needsWindow = true;
        }
      }

      if (ready && needsWindow && probe && !(await probe())) {
        ready = false;
        waitingOn = "the service is not accepting connections";
      }
    } catch {
      ready = false;
    }

    if (!ready) {
      readySince = null;
    } else if (!needsWindow) {
      return true;
    } else {
      readySince ??= Date.now();
      if (Date.now() - readySince >= stableMs) return true;
    }

    await sleep(intervalMs);
  }

  logs.push(`[health] Timeout after ${timeoutMs / 1000}s — ${readySince ? "not ready long enough" : waitingOn}`);
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

  await checkVolumeLimits(ctx);

  // x-vardo-shared services run in their own project and are never stopped by a swap.
  const { shared, slotted } = partitionBySlot(compose);
  const sharedNames = Object.keys(shared);
  const slottedNames = Object.keys(slotted);
  const sharedProject = sharedProjectName(app.name, ctx.envName, compose.name);

  const onlySlotted = slotScopeArgs({ shared, slotted });

  const mustStopOldSlot = activeSlot !== null && !isLocalEnv;

  // Slots overlap only when no slotted service publishes a host port; otherwise the second bind fails.
  const canOverlapSlots = mustStopOldSlot && !publishesHostPorts(slotted);
  const stopOldBeforeUp = mustStopOldSlot && !canOverlapSlots;

  // A self-deploy's old slot runs this process, so its stop waits until post-deploy writes are durable.
  const deferStopToPostDeploy = deferSlotStop(canOverlapSlots, app.name);
  let pinCutover = canPinCutover(canOverlapSlots);

  // Appended to new-slot failures.
  const overlapDiagnosis = () => slotOverlapDiagnosis(compose, slotted, canOverlapSlots);

  // OOM kills after this belong to this deploy.
  const swapStartedAt = new Date();

  // Clear a pin left by a deploy killed mid-cutover.
  await clearCutoverPin(app.name, ctx.envName).catch(() => {});

  // Remove leftovers from a previous failed deploy in the new slot.
  try {
    await execFileAsync(
      "docker",
      ["compose", ...composeFileArgs, "-p", newProjectName, "down", "--remove-orphans"],
      { env: dockerEnv(), cwd: slotDir, timeout: COMPOSE_DOWN_TIMEOUT }
    );
  } catch {
    // Nothing to clean up.
  }

  // Step 6a: build and pull new-slot images while the old slot keeps serving.
  const { buildServices, pullServices } = classifyComposeServices(
    compose.services,
    ctx.builtImageRefs,
  );

  /** Whether the host already holds an image. */
  const imageIsLocal = async (image: string): Promise<boolean> => {
    try {
      await execFileAsync("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
        env: dockerEnv(),
        timeout: COMPOSE_QUERY_TIMEOUT,
      });
      return true;
    } catch {
      return false;
    }
  };

  // Shared images missing from the host are pulled now, before the old slot may stop.
  const sharedPulls = await sharedPullTargets(shared, ctx.builtImageRefs, imageIsLocal);

  let majorGate: MajorGateState = { candidates: [], before: new Map() };
  try {
    // Builds pull base images too, so both phases use registry credentials.
    await withRegistryAuth(async (env) => {
      if (buildServices.length > 0) {
        log(`[deploy] Pre-building ${newSlot} slot images (old slot still serving)...`);
        const bounded = await boundedBuild(log, ctx.signal);
        const buildStart = Date.now();
        const { stdout, stderr } = await execFileAsync(
          "docker",
          ["compose", "--progress=plain", ...composeFileArgs, "-p", newProjectName, "build"],
          { cwd: slotDir, env: { ...env, ...bounded.env }, timeout: COMPOSE_BUILD_UP_TIMEOUT, maxBuffer: EXEC_MAX_BUFFER, signal: ctx.signal }
        ).catch((err: unknown) => {
          ctx.timer.range("build", buildStart, Date.now());
          throw explainBuildOom(err, bounded);
        });
        // BuildKit runs the export inside the build; split it out of the build time.
        const buildEnd = Date.now();
        const exportMs = Math.min(exportMsFromBuildOutput(`${stdout}\n${stderr}`), buildEnd - buildStart);
        ctx.timer.range("build", buildStart, buildEnd - exportMs);
        if (exportMs > 0) ctx.timer.range("export", buildEnd - exportMs, buildEnd);
        for (const line of stdout.split(/\r?\n|\r/).filter(Boolean)) {
          logs.push(`[deploy][build] ${line.trim()}`);
        }
        for (const line of stderr.split(/\r?\n|\r/).filter(Boolean)) {
          logs.push(`[deploy][build] ${line.trim()}`);
        }
      }
      if (pullServices.length > 0) {
        // Read engine majors before the pull moves the tag.
        majorGate = await majorGateBefore(ctx, pullServices);
        log(`[deploy] Pre-pulling ${newSlot} slot images (old slot still serving)...`);
        const { stdout, stderr } = await ctx.timer.span("pull", () => execFileAsync(
          "docker",
          ["compose", ...composeFileArgs, "-p", newProjectName, "pull", ...pullServices],
          { cwd: slotDir, env, timeout: COMPOSE_UP_TIMEOUT, maxBuffer: EXEC_MAX_BUFFER, signal: ctx.signal }
        ));
        for (const line of stdout.split(/\r?\n|\r/).filter(Boolean)) {
          logs.push(`[deploy][pull] ${line.trim()}`);
        }
        for (const line of stderr.split(/\r?\n|\r/).filter(Boolean)) {
          logs.push(`[deploy][pull] ${line.trim()}`);
        }
      }
      if (sharedPulls.length > 0) {
        log(`[deploy] Pre-pulling shared images: ${sharedPulls.join(", ")} (old slot still serving)...`);
        const { stdout, stderr } = await ctx.timer.span("pull", () => execFileAsync(
          "docker",
          ["compose", ...composeFileArgs, "-p", sharedProject, "pull", ...sharedPulls],
          { cwd: slotDir, env, timeout: COMPOSE_UP_TIMEOUT, maxBuffer: EXEC_MAX_BUFFER, signal: ctx.signal }
        ));
        for (const line of `${stdout}\n${stderr}`.split(/\r?\n|\r/).filter(Boolean)) {
          logs.push(`[deploy][pull] ${line.trim()}`);
        }
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = await registryAuthHint(
      message,
      [...pullServices, ...sharedPulls].map((name) => compose.services[name]?.image),
    );
    throw new Error(
      `Pre-build/pre-pull for ${newSlot} failed (old slot unaffected): ${message}` +
        (hint ? `\n${hint}` : "")
    );
  }

  // Block an unversioned tag that crossed an engine major, while nothing has been replaced.
  await majorGateAfter(ctx, majorGate);

  // Last point at which a cancel is free.
  ctx.checkAbort();
  ctx.stage("build", "success");
  ctx.stage("deploy", "running");

  // Step 6b: stop the old slot when it can't overlap.
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

  // Stopped services, restarted if the new slot fails.
  const stoppedOldServices: string[] = [];

  // Whether the old slot was demoted to `restart: no`; tracked apart from the stop.
  let demotedOldSlot = false;

  /** Whether the old slot still runs any of these services. */
  const oldSlotRuns = async (names: string[]): Promise<boolean> => {
    if (!oldSlotDir || !oldProjectName) return false;
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["compose", ...(await getOldComposeFileArgs()), "-p", oldProjectName, "ps", "-q", ...names],
        { env: dockerEnv(), cwd: oldSlotDir, timeout: COMPOSE_QUERY_TIMEOUT },
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  };

  let stoppedOldSlot = false;

  const stopOldSlot = async (): Promise<SlotStopOutcome> => {
    if (!oldSlotDir || !oldProjectName || stoppedOldSlot) return { ok: true };
    stoppedOldSlot = true;
    const oldComposeFileArgs = await getOldComposeFileArgs();
    log(`[deploy] Stopping old slot (${activeSlot})...`);

    const stop = async (): Promise<SlotStopOutcome> => {
      try {
        // Demote before stopping: a self-deploy has no "after". Never move this below the stop.
        demotedOldSlot = true;
        await demoteStandbyRestart(oldComposeFileArgs, oldProjectName, oldSlotDir);
        // `stop`, not `down`: the old slot stays as a warm standby for rollback.
        await execFileAsync(
          "docker",
          ["compose", ...oldComposeFileArgs, "-p", oldProjectName, "stop"],
          { env: dockerEnv(), cwd: oldSlotDir, timeout: COMPOSE_DOWN_TIMEOUT }
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!alreadyGone(message)) {
          log(`[deploy] Warning: could not stop old slot — ${message}`);
          return { ok: false, message };
        }
      }
      stoppedOldServices.push("__all__");
      return { ok: true };
    };

    const outcome = pinCutover
      ? await drainThenStop(
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
        )
      : await stop();

    await reportOomDuringDeploy(
      { organizationId: ctx.organizationId, appId: ctx.appId, appName: app.displayName || app.name },
      oldProjectName,
      swapStartedAt,
      log,
    );

    return outcome;
  };

  // A slot that won't stop can return as a second Traefik backend after a daemon restart.
  const noteStopFailure = (outcome: SlotStopOutcome) => {
    if (outcome.ok) return;
    (ctx.unfinished ??= []).push(
      `the old slot (${activeSlot}) is still running — ${outcome.message}`,
    );
  };

  // An old slot still running a now-shared service must stop before the shared project claims its volume.
  const oldSlotHoldsShared =
    mustStopOldSlot && !deferStopToPostDeploy && sharedNames.length > 0
      ? await oldSlotRuns(sharedNames)
      : false;

  // Externalized volumes are shared by both slots, so overlap is off for the whole app. Self-deploy exempt.
  const slottedOnExternalizedVolumes =
    canOverlapSlots && !deferStopToPostDeploy
      ? [...getServicesWithExternalizedVolumes(compose)].filter((name) => name in slotted)
      : [];

  // Overlap runs two copies of the app; check memory after the build. Self-deploy exempt.
  const overlapFitsMemory =
    canOverlapSlots &&
    !deferStopToPostDeploy &&
    !oldSlotHoldsShared &&
    slottedOnExternalizedVolumes.length === 0
      ? await overlapFitsNow(ctx.organizationId, ctx.appId, log)
      : true;

  if (
    stopOldBeforeUp ||
    oldSlotHoldsShared ||
    slottedOnExternalizedVolumes.length > 0 ||
    !overlapFitsMemory
  ) {
    if (oldSlotHoldsShared) {
      log(`[deploy] Old slot still runs ${sharedNames.join(", ")} — stopping it before the shared project starts`);
    }
    if (slottedOnExternalizedVolumes.length > 0) {
      log(`[deploy] Volume both slots would hold, mounted by ${slottedOnExternalizedVolumes.join(", ")} — stopping ${activeSlot} before ${newSlot} starts`);
    }
    // No second backend to pin to when stopping first.
    pinCutover = false;
    noteStopFailure(await stopOldSlot());
  } else if (canOverlapSlots) {
    log(`[deploy] No published host ports — ${activeSlot} keeps serving until ${newSlot} is healthy`);
  }

  // A pre-shared old slot uses its own project network; shared containers must rejoin it on restore.
  const rejoinOldSlotNetworks = async () => {
    if (!oldProjectName) return;
    const networks = projectScopedNetworkNames(compose, oldProjectName);
    if (networks.length === 0) return;
    for (const name of sharedNames) {
      const container = shared[name].container_name ?? `${sharedProject}-${name}-1`;
      for (const network of networks) {
        await execFileAsync(
          "docker",
          ["network", "connect", "--alias", name, network, container],
          { env: dockerEnv(), timeout: COMPOSE_QUERY_TIMEOUT },
        ).catch(() => { /* already attached or gone */ });
      }
    }
    log(`[deploy] Reattached ${sharedNames.join(", ")} to ${networks.join(", ")}`);
  };

  // Restart the old slot after a failed cutover. Best-effort, never throws.
  // Uses `up --no-recreate`, not `start`, so containers removed since the stop come back.
  const restoreOldSlot = async (reason: string) => {
    if (!oldSlotDir || !oldProjectName) return;
    if (stoppedOldServices.length === 0 && !demotedOldSlot) return;
    const serviceNames = stoppedOldServices.filter((s) => s !== "__all__");
    log(`[deploy] Restoring old-slot services after ${reason}: ${serviceNames.length > 0 ? serviceNames.join(", ") : "all"}`);
    try {
      const oldComposeFileArgs = await getOldComposeFileArgs();
      // Rejoin before the up so the database is reachable.
      if (oldSlotHoldsShared) await rejoinOldSlotNetworks();
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
        { env: dockerEnv(), cwd: oldSlotDir, timeout: COMPOSE_UP_TIMEOUT }
      );
      await restoreSlotRestart(oldComposeFileArgs, oldProjectName, oldSlotDir);
      // Idempotent.
    } catch (err) {
      log(`[deploy] Warning: failed to restore old-slot services — ${err instanceof Error ? err.message : err}`);
    }
  };

  // A failed recreate puts the service back on the old slot's definition.
  const reconcileShared = async () => {
    try {
      const outcomes = await reconcileSharedServices({
        shared,
        project: sharedProject,
        composeFileArgs,
        cwd: slotDir,
        exec: (args, opts) => execFileAsync("docker", args, { env: dockerEnv(), ...opts, maxBuffer: EXEC_MAX_BUFFER }),
        timeout: COMPOSE_QUERY_TIMEOUT,
        upTimeout: COMPOSE_UP_TIMEOUT,
        readyTimeout: sharedReadyTimeout,
        intervalMs: HEALTH_CHECK_INTERVAL_MS,
        stableMs: HEALTH_STABLE_WINDOW_MS,
        sleep,
        log,
        pendingMoves: ctx.sharedPathMoves,
      });
      for (const outcome of outcomes) {
        log(describeSharedOutcome(outcome));
        if (outcome.result === "held") {
          (ctx.unfinished ??= []).push(
            `shared service ${outcome.service} still runs its old definition (${outcome.reason}) — apply it with: ` +
              `cd ${slotDir} && docker compose ${composeFileArgs.join(" ")} -p ${sharedProject} up -d --no-deps ${outcome.service}`,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[deploy] ${message}`);
      if (err instanceof SharedRecreateError) await restoreSharedDefinition(err.service);
      await restoreOldSlot("a shared service failing after recreate");
      throw new Error(message);
    }
  };

  // Best effort, from the old slot's compose.
  const restoreSharedDefinition = async (service: string) => {
    if (!oldSlotDir) return;
    try {
      await execFileAsync(
        "docker",
        [
          "compose",
          ...(await getOldComposeFileArgs()),
          "-p", sharedProject,
          "up", "-d",
          "--no-deps",
          "--pull", "never",
          service,
        ],
        { env: dockerEnv(), cwd: oldSlotDir, timeout: COMPOSE_UP_TIMEOUT, maxBuffer: EXEC_MAX_BUFFER }
      );
      log(`[deploy] Put ${service} back on the ${activeSlot} slot's definition`);
    } catch (err) {
      log(`[deploy] Warning: could not put ${service} back on its previous definition — ${err instanceof Error ? err.message : err}`);
    }
  };

  // Step 6b2: start missing shared services before the new slot. `--no-recreate` never touches a running data store.
  if (sharedNames.length > 0) {
    log(`[deploy] Shared services (not rotated): ${sharedNames.join(", ")}`);
    try {
      // `--pull never`: a registry pull here would be downtime.
      const { stdout, stderr } = await execFileAsync(
        "docker",
        [
          "compose",
          ...composeFileArgs,
          "-p", sharedProject,
          "up", "-d",
          "--no-recreate",
          "--pull", "never",
          "--no-deps",
          ...sharedNames,
        ],
        { env: dockerEnv(), cwd: slotDir, timeout: COMPOSE_UP_TIMEOUT, maxBuffer: EXEC_MAX_BUFFER }
      );
      for (const line of `${stdout}\n${stderr}`.split(/\r?\n|\r/).filter(Boolean)) {
        logs.push(`[deploy][shared] ${line.trim()}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await restoreOldSlot("shared services failing to start");
      throw new Error(`Shared services failed to start: ${message}`);
    }

    await reconcileShared();
  }

  // Step 6c: chown bind-mount targets to non-root uids (#738). Needs the images.
  await prepareBindMountOwnership(ctx);

  // Step 7: start the new slot from local images.
  const composeUpTimeout = buildServices.length > 0 ? COMPOSE_BUILD_UP_TIMEOUT : COMPOSE_UP_TIMEOUT;
  log(`[deploy] Starting ${newSlot} slot...`);
  try {
    const { stdout, stderr } = await ctx.timer.span("up", () => execFileAsync(
      "docker",
      ["compose", ...composeFileArgs, "-p", newProjectName, "up", "-d", "--pull", "never", ...onlySlotted],
      { env: dockerEnv(), cwd: slotDir, timeout: composeUpTimeout, maxBuffer: EXEC_MAX_BUFFER }
    ));
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
      { env: dockerEnv(), cwd: slotDir, timeout: COMPOSE_DOWN_TIMEOUT }
    ).catch(() => {});
    await restoreOldSlot("compose up failure");
    throw new Error(
      [`docker compose up (${newSlot}) failed: ${message}`, overlapDiagnosis()]
        .filter(Boolean)
        .join("\n"),
    );
  }

  // Step 8: health check.
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

  // Probe the container Traefik routes to; the wrong one fails open.
  const routed = getTraefikRoutedServices(compose);
  const routedName =
    [...routed][0] ?? selectRoutedService(compose, { containerPort }).service;
  // A shared routed service isn't replaced, so probing it proves nothing.
  const primarySvcName = sharedNames.includes(routedName) ? undefined : routedName;
  // Only Traefik-routed services are reachable on vardo-network.
  const probePort = primarySvcName
    ? routedPort(compose.services[primarySvcName]) ?? containerPort
    : 0;
  const probe =
    primarySvcName && routed.has(primarySvcName) && probePort > 0
      ? tcpProbe(`${newProjectName}-${primarySvcName}-1`, probePort)
      : undefined;

  const healthy = await waitForHealthy(newProjectName, composeFileArgs, slotDir, logs, healthTimeoutMs, probe);
  if (!healthy) {
    log(`[deploy] Health check failed — fetching container logs...`);
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["compose", ...composeFileArgs, "-p", newProjectName, "logs", "--tail", "30"],
        { env: dockerEnv(), cwd: slotDir, timeout: COMPOSE_QUERY_TIMEOUT, maxBuffer: EXEC_MAX_BUFFER }
      );
      if (stdout.trim()) {
        for (const line of stdout.trim().split("\n")) {
          log(`[deploy][crash] ${line}`);
        }
      }
    } catch { /* no logs */ }

    log(`[deploy] Tearing down ${newSlot}`);
    await execFileAsync(
      "docker",
      ["compose", ...composeFileArgs, "-p", newProjectName, "down", "--remove-orphans"],
      { env: dockerEnv(), cwd: slotDir, timeout: COMPOSE_DOWN_TIMEOUT }
    ).catch(() => {});
    await restoreOldSlot("health check failure");
    throw new Error(
      [
        `${newSlot} slot did not become healthy — container may have crashed (see logs above)`,
        overlapDiagnosis(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  ctx.stage("healthcheck", "success");
  ctx.stage("routing", "running");
  log(`[deploy] ${newSlot} healthy`);

  // Invariant: an old slot still serving is stopped only after the deploy commits.
  if (mustStopOldSlot && !stoppedOldSlot) {
    ctx.stopOldSlot = stopOldSlot;
    ctx.stopOldSlotEndsDeploy = deferStopToPostDeploy;
    ctx.oldSlotServing = () => oldSlotRuns(slottedNames);
  }

  // Step 9: record container names for the default environment.
  if (!isLocalEnv && !ctx.envIsolated) {
    try {
      const serviceNames = Object.keys(compose.services);
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
