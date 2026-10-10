// Vardo's own lifecycle: heartbeat, clean-shutdown marker, boot announcement and update markers.

import { readFile } from "fs/promises";
import { join } from "path";
import { hostname, uptime } from "os";
import { eq } from "drizzle-orm";
import pkg from "@/package.json";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import type { BusEvent } from "@/lib/bus/events";
import { emit } from "@/lib/notifications/dispatch";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { logger } from "@/lib/logger";
import { LIFECYCLE_DIR } from "@/lib/paths";
import { closeOnShutdown, shutdownSignal } from "@/lib/shutdown";
import { getBuildSha } from "@/lib/version";
import { formatDuration } from "@/lib/email/format";
import { formatVersion } from "./self-deploy";
import {
  classifyBoot,
  isConsoleHandover,
  isOtherConsole,
  markSeen,
  missingContainers,
  parseBtime,
  parseUpdateMarker,
  ranSelfDeploy,
  seconds,
  stoppingForSelfDeploy,
  updateAnnouncement,
  updateInFlight,
  type BootClassification,
  type Heartbeat,
  type ShutdownMarker,
  type SnapshotContainer,
  type UpdateMarker,
  type UpdateSeen,
} from "./classify";

const log = logger.child("lifecycle");

export const HEARTBEAT_KEY = "lifecycle_heartbeat";
export const SHUTDOWN_KEY = "lifecycle_shutdown";
export const UPDATE_SEEN_KEY = "lifecycle_update_seen";
export const UPDATE_MARKER_FILE = join(LIFECYCLE_DIR, "update.json");

const HEARTBEAT_MS = 30_000;
const MISSING_CHECK_DELAY_MS = 3 * 60_000;
/** How often, and how long, a console booted mid-update waits for install.sh to report. */
export const UPDATE_POLL_MS = 5_000;
export const UPDATE_WAIT_MS = 10 * 60_000;

export function versionLabel(): string {
  return formatVersion(pkg.version, getBuildSha()) ?? pkg.version;
}

async function readJson<T>(key: string): Promise<T | null> {
  const row = await db.query.systemSettings.findFirst({ where: (t, { eq }) => eq(t.key, key) });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  await db
    .insert(systemSettings)
    .values({ key, value: text })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: text, updatedAt: new Date() } });
}

async function clearSetting(key: string): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.key, key));
}

/** Host boot time: /proc/stat btime, which procfs doesn't namespace, then os.uptime(). */
export async function hostBootTime(): Promise<number | null> {
  const reads = [() => readFile("/host-proc/stat", "utf-8"), () => readFile("/proc/stat", "utf-8")];
  for (const read of reads) {
    try {
      const btime = parseBtime(await read());
      if (btime) return btime;
    } catch {
      // Not Linux, or not mounted.
    }
  }
  const up = uptime();
  return up > 0 ? Date.now() - up * 1000 : null;
}

/** This console's hostname: its container id unless set otherwise. */
export function selfHost(): string {
  return process.env.CONTAINER_ID ?? hostname();
}

async function readUpdateMarker(): Promise<UpdateMarker | null> {
  try {
    return parseUpdateMarker(await readFile(UPDATE_MARKER_FILE, "utf-8"));
  } catch {
    return null;
  }
}

async function emitToAdmins(event: BusEvent): Promise<void> {
  try {
    for (const orgId of await adminOrgIds()) emit(orgId, event);
  } catch (err) {
    log.error(`Couldn't send ${event.type}:`, err);
  }
}

/** Vardo-managed containers running now. */
async function runningManagedContainers(): Promise<SnapshotContainer[]> {
  const { listContainers } = await import("@/lib/docker/client");
  const containers = await listContainers();
  return containers
    .filter((c) => c.labels["vardo.managed"] === "true")
    .map((c) => ({ id: c.id, name: c.name, app: c.labels["vardo.project"] || undefined }));
}

async function beat(): Promise<void> {
  const containers = await runningManagedContainers().catch(() => undefined);
  const heartbeat: Heartbeat = { at: Date.now(), hostBootAt: await hostBootTime(), version: versionLabel(), containers, host: selfHost() };
  await writeJson(HEARTBEAT_KEY, heartbeat);
}

function describeSignal(signal: string | undefined): string {
  if (signal === "SIGINT") return "Interrupted (SIGINT)";
  return "Stop signal: host shutdown, restart or container stop";
}

function updateEvent(marker: UpdateMarker, state: UpdateMarker["state"], downSeconds?: number): BusEvent {
  const version = marker.toVersion ? `${marker.fromVersion} → ${marker.toVersion}` : marker.fromVersion;
  const durationSeconds = seconds(marker.startedAt, marker.finishedAt);
  switch (state) {
    case "started":
      return {
        type: "system.update-started",
        title: "Vardo update started",
        message: `vardo update started from ${marker.fromVersion}.`,
        fromVersion: marker.fromVersion,
        branch: marker.branch,
        fromSlot: marker.fromSlot,
        toSlot: marker.toSlot,
      };
    case "updated":
      return {
        type: "system.updated",
        title: "Vardo updated",
        message: `Vardo updated ${version}${durationSeconds !== undefined ? ` in ${formatDuration(durationSeconds * 1000)}` : ""}.`,
        fromVersion: marker.fromVersion,
        toVersion: marker.toVersion ?? "unknown version",
        fromSlot: marker.fromSlot,
        toSlot: marker.toSlot,
        durationSeconds,
        downSeconds: seconds(marker.swapStartedAt, marker.healthyAt) ?? downSeconds,
      };
    case "failed":
      return {
        type: "system.update-failed",
        title: "Vardo update failed",
        message: `vardo update failed at ${marker.step ?? "an unknown step"}${marker.error ? `: ${marker.error}` : "."}`,
        fromVersion: marker.fromVersion,
        toVersion: marker.toVersion,
        fromSlot: marker.fromSlot,
        toSlot: marker.toSlot,
        step: marker.step ?? "an unknown step",
        error: marker.error,
        durationSeconds,
        rolledBack: marker.rolledBack,
        logTail: marker.logTail,
      };
  }
}

/** This process's start, and how long the console was down before it. */
const processStartedAt = Date.now() - Math.round(process.uptime() * 1000);
let bootDownSeconds: number | undefined;

// Update announcements run one at a time, so the boot wait and the heartbeat can't both send one.
let updateQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = updateQueue.then(fn, fn);
  updateQueue = run.catch(() => {});
  return run;
}

/** Announces an update marker state not yet announced. Returns the state announced. */
export function checkUpdateMarker(): Promise<UpdateMarker["state"] | null> {
  return serialized(async () => {
    const marker = await readUpdateMarker();
    if (!marker) return null;
    const seen = await readJson<UpdateSeen>(UPDATE_SEEN_KEY);
    const state = updateAnnouncement(marker, seen, Date.now());
    if (!state) return null;
    // The console an update started is the new one; its "updated" message covers the start.
    if (state === "started" && marker.startedAt < processStartedAt) return null;
    // A self-deploy's new console reports the result; the old one is about to stop.
    if (state === "updated" && ranSelfDeploy(marker, selfHost())) return null;
    await writeJson(UPDATE_SEEN_KEY, markSeen(seen, marker, state));
    await emitToAdmins(updateEvent(marker, state, bootDownSeconds));
    log.info(`Announced update ${marker.id}: ${state}`);
    return state;
  });
}

/** Reports an update install.sh never finished, unless its outcome was announced meanwhile. */
function announceUpdateSilent(marker: UpdateMarker): Promise<void> {
  return serialized(async () => {
    const seen = await readJson<UpdateSeen>(UPDATE_SEEN_KEY);
    if (seen?.id === marker.id && seen.states.some((s) => s !== "started")) return;
    await writeJson(UPDATE_SEEN_KEY, markSeen(seen, marker, "failed"));
    const minutes = Math.round(UPDATE_WAIT_MS / 60_000);
    await emitToAdmins(
      updateEvent(
        {
          ...marker,
          state: "failed",
          step: marker.step ?? "the swap",
          error: `vardo update didn't report a result within ${minutes} minutes of the new console starting. Check the install log.`,
        },
        "failed",
      ),
    );
    log.warn(`Update ${marker.id} didn't report a result`);
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** Waits for an update this console booted into to finish, then announces it. */
async function awaitUpdateOutcome(started: UpdateMarker): Promise<void> {
  const deadline = Date.now() + UPDATE_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(UPDATE_POLL_MS);
    const marker = await readUpdateMarker();
    if (marker?.id === started.id && marker.state === "started") continue;
    await checkUpdateMarker();
    return;
  }
  await announceUpdateSilent(started);
}

function bootEvent(boot: BootClassification): BusEvent | null {
  const version = versionLabel();
  switch (boot.kind) {
    case "first-boot":
      return null;
    case "clean":
      return {
        type: "system.started",
        title: "Vardo started",
        message: `Vardo is back after ${formatDuration(boot.downSeconds * 1000)}${boot.hostRebooted ? " and a host reboot" : ""}.`,
        version,
        downSeconds: boot.downSeconds,
        hostRebooted: boot.hostRebooted,
        reason: boot.reason,
      };
    case "unclean":
      return {
        type: "system.recovered-unclean",
        title: "Vardo recovered after an unclean stop",
        message: "Vardo came back without a clean-shutdown marker: power loss, a forced stop or a crash.",
        version,
        downSeconds: boot.downSeconds,
        hostRebooted: boot.hostRebooted,
        lastHeartbeatAt: boot.lastHeartbeatAt,
      };
  }
}

async function checkMissingContainers(before: SnapshotContainer[]): Promise<void> {
  try {
    const { listAllContainers, inspectContainer } = await import("@/lib/docker/client");
    const all = await listAllContainers();
    const ids = new Set(before.map((c) => c.id));
    const now = await Promise.all(
      all
        .filter((c) => ids.has(c.id))
        .map(async (c) => ({
          id: c.id,
          state: c.state,
          restartPolicy: c.state === "running" ? undefined : await inspectContainer(c.id).then((i) => i.restartPolicy, () => undefined),
        })),
    );
    const missing = missingContainers(before, now);
    if (missing.length === 0) return;
    log.warn(`${missing.length} container(s) didn't come back: ${missing.map((c) => c.name).join(", ")}`);
    await emitToAdmins({
      type: "system.containers-missing",
      title: "Containers didn't come back",
      message: `${missing.length} container(s) were running before the restart and aren't now.`,
      containers: missing.map((c) => ({ name: c.name, app: c.app, state: c.state })),
    });
  } catch (err) {
    log.error("Missing container check failed:", err);
  }
}

async function onShutdown(): Promise<void> {
  const marker = await readUpdateMarker().catch(() => null);
  // The new console is already up; a shutdown marker or email from this one would be noise.
  if (stoppingForSelfDeploy(marker, selfHost(), Date.now())) {
    log.info(`Stopping at the end of self-deploy ${marker?.id}`);
    return;
  }
  const updating = updateInFlight(marker, Date.now());
  const reason = updating ? "vardo update" : describeSignal(shutdownSignal());
  const shutdown: ShutdownMarker = { at: Date.now(), reason, version: versionLabel() };
  await writeJson(SHUTDOWN_KEY, shutdown).catch((err) => log.error("Couldn't write the shutdown marker:", err));

  // An update announces itself; a separate shutdown email would double it.
  if (updating) {
    await checkUpdateMarker().catch(() => null);
    return;
  }
  await emitToAdmins({
    type: "system.shutdown",
    title: "Vardo shutting down",
    message: `Vardo is shutting down: ${reason}.`,
    reason,
    version: shutdown.version,
    uptimeSeconds: Math.round(process.uptime()),
  });
}

const globalForLifecycle = globalThis as unknown as { __vardo_lifecycle?: boolean };

/** Whether another console container is running now. */
async function otherConsoleRunning(): Promise<boolean> {
  try {
    const { listContainers } = await import("@/lib/docker/client");
    const host = selfHost();
    return (await listContainers()).some((c) => isOtherConsole(c, host));
  } catch {
    return false;
  }
}

/** Classifies this boot, announces it once and starts the heartbeat. */
export async function startLifecycleMonitor(): Promise<void> {
  if (globalForLifecycle.__vardo_lifecycle) return;
  globalForLifecycle.__vardo_lifecycle = true;

  const startedAt = processStartedAt;
  const [heartbeat, shutdown, hostBootAt] = await Promise.all([
    readJson<Heartbeat>(HEARTBEAT_KEY),
    readJson<ShutdownMarker>(SHUTDOWN_KEY),
    hostBootTime(),
  ]);
  const boot = classifyBoot({ heartbeat, shutdown, hostBootAt, startedAt });
  log.info(`Boot: ${boot.kind}${boot.kind !== "first-boot" && boot.hostRebooted ? " after a host reboot" : ""}`);

  await clearSetting(SHUTDOWN_KEY).catch(() => {});
  await beat().catch((err) => log.warn("Heartbeat failed:", err));

  const interval = setInterval(() => {
    beat().catch((err) => log.warn("Heartbeat failed:", err));
    checkUpdateMarker().catch((err) => log.warn("Update marker check failed:", err));
  }, HEARTBEAT_MS);
  interval.unref();

  closeOnShutdown(() => {
    clearInterval(interval);
    return onShutdown().catch(() => {});
  });

  // One message per boot. A boot inside an update says only how the update ended.
  bootDownSeconds = boot.kind === "first-boot" ? undefined : boot.downSeconds;
  const marker = await readUpdateMarker();
  if (updateInFlight(marker, Date.now())) {
    log.info(`Update ${marker.id} in progress; waiting for its result`);
    void awaitUpdateOutcome(marker).catch((err) => log.error("Update wait failed:", err));
  } else {
    const announced = await checkUpdateMarker().catch(() => null);
    const handover =
      !announced &&
      boot.kind === "unclean" &&
      isConsoleHandover({ heartbeat, startedAt, selfHost: selfHost(), otherConsoleRunning: await otherConsoleRunning() });
    if (handover) log.info("Boot: took over from a console still running, no restart to report");
    if (!announced && !handover) {
      const event = bootEvent(boot);
      if (event) await emitToAdmins(event);
    }
  }

  const before = heartbeat?.containers ?? [];
  if (boot.kind !== "first-boot" && boot.hostRebooted && before.length > 0) {
    setTimeout(() => {
      checkMissingContainers(before).catch(() => {});
    }, MISSING_CHECK_DELAY_MS).unref();
  }
}
