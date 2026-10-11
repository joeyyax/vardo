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
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { getBuildSha } from "@/lib/version";
import { formatDuration } from "@/lib/email/format";
import { formatVersion } from "./self-deploy";
import {
  classifyBoot,
  isConsoleHandover,
  isOtherConsole,
  missingContainers,
  parseBtime,
  parseUpdateMarker,
  stoppingForSelfDeploy,
  updateInFlight,
  type BootClassification,
  type Heartbeat,
  type ShutdownMarker,
  type SnapshotContainer,
  type UpdateMarker,
} from "./classify";

const log = logger.child("lifecycle");

export const HEARTBEAT_KEY = "lifecycle_heartbeat";
export const SHUTDOWN_KEY = "lifecycle_shutdown";
export const UPDATE_MARKER_FILE = join(LIFECYCLE_DIR, "update.json");

const HEARTBEAT_MS = 30_000;
const MISSING_CHECK_DELAY_MS = 3 * 60_000;
/** How often a console booted mid-update reads the marker. */
export const UPDATE_POLL_MS = 5_000;

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

/** This process's start, and how long the console was down before it. */
const processStartedAt = Date.now() - Math.round(process.uptime() * 1000);
let bootDownSeconds: number | undefined;

/** Hands the update marker to the update lifecycle. Returns the notice it sent. */
export async function checkUpdateMarker(marker?: UpdateMarker | null): Promise<UpdateMarker["state"] | null> {
  const { ingestUpdateMarker } = await import("@/lib/self-update/lifecycle");
  return ingestUpdateMarker(marker === undefined ? await readUpdateMarker() : marker, {
    host: selfHost(),
    processStartedAt,
    downSeconds: bootDownSeconds,
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** Follows an update this console booted into until the lifecycle closes it. */
async function watchUpdate(): Promise<void> {
  const { activeUpdate, awaitResult, reconcileUpdate } = await import("@/lib/self-update/lifecycle");
  await awaitResult();
  while (await activeUpdate()) {
    await sleep(UPDATE_POLL_MS);
    await checkUpdateMarker().catch((err) => log.warn("Update marker check failed:", err));
    await reconcileUpdate();
  }
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

/** Per process: each console records its own heartbeat. */
export const lifecycleHeartbeatLoop = new IntervalLoop({
  name: "lifecycle-heartbeat",
  intervalMs: HEARTBEAT_MS,
  log,
  run: async () => {
    const [beaten] = await Promise.allSettled([
      beat(),
      checkUpdateMarker()
        .then(async () => (await import("@/lib/self-update/lifecycle")).reconcileUpdate())
        .catch((err) => log.warn("Update marker check failed:", err)),
    ]);
    if (beaten.status === "rejected") throw beaten.reason;
  },
});

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

  lifecycleHeartbeatLoop.start({ role: "web" });

  closeOnShutdown(() => onShutdown().catch(() => {}));

  // One message per boot. A boot inside an update says only how the update ended.
  bootDownSeconds = boot.kind === "first-boot" ? undefined : boot.downSeconds;
  const marker = await readUpdateMarker();
  if (updateInFlight(marker, Date.now())) {
    log.info(`Update ${marker.id} in progress; waiting for its result`);
    await checkUpdateMarker(marker).catch(() => null);
    void watchUpdate().catch((err) => log.error("Update wait failed:", err));
  } else {
    const announced = await checkUpdateMarker(marker).catch(() => null);
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
