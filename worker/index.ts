// vardo-worker: the background loops from lib/worker/registry.ts, outside the web process.

import { ownSlot } from "@/lib/docker/own-slot";
import { logger } from "@/lib/logger";
import { closeOnShutdown, configureShutdown } from "@/lib/shutdown";
import { instanceId } from "@/lib/worker/instance";
import { WORKER_BEAT_MS, workerDrainMs, workerHealthPort } from "@/lib/worker/mode";
import { beatWorker, registerWorker } from "@/lib/worker/presence";
import { startLoops, startedLoops, stopLoops } from "@/lib/worker/start";
import { assertSchemaCurrent, awaitBoot, bootState, markBooted, markDraining, markStopping } from "./boot";
import { drainWork } from "./drain";
import { startHealthServer } from "./health";

const log = logger.child("worker");
const id = instanceId();
const drainMs = workerDrainMs();

// Covers the drain plus the final heartbeat and closing connections.
configureShutdown({ drainMs: drainMs + 15_000, exitWhenDrained: true });

function crash(kind: string, err: unknown): void {
  log.error(`${kind}, exiting:`, err);
  process.exit(1);
}
process.on("uncaughtException", (err) => crash("Uncaught exception", err));
process.on("unhandledRejection", (err) => crash("Unhandled rejection", err));

function inFlight(): string[] {
  return [...startedLoops()].filter(([, loop]) => loop.busy).map(([name]) => name);
}

let beating: Promise<unknown> = Promise.resolve();

function beat(): Promise<unknown> {
  const state = bootState();
  beating = beating
    .then(() => beatWorker(id, { inFlight: inFlight(), ready: state.booted, draining: state.draining }))
    .then(({ drainRequested }) => {
      if (drainRequested && !bootState().draining) void drain("requested");
    })
    .catch((err) => log.warn("Heartbeat failed:", err));
  return beating;
}

/** Stops claiming work and lets passes in flight finish; leases go back as each loop stops. */
async function drain(reason: string): Promise<void> {
  markDraining();
  log.info(`Draining (${reason}): up to ${Math.round(drainMs / 1000)}s for ${inFlight().join(", ") || "no passes in flight"}`);
  const { drainBackupsForStop } = await import("@/lib/backups/in-flight");
  const settled = await drainWork({
    stopLoops: () => stopLoops(),
    drainBackups: (budgetMs) => drainBackupsForStop((line) => log.info(line), budgetMs),
    budgetMs: drainMs,
  });
  if (settled === "timeout") log.warn(`Drain budget spent with ${inFlight().join(", ") || "backup work"} still running`);
  else log.info("Drained");
}

async function main(): Promise<void> {
  log.info(`Worker ${id} starting`);
  const server = startHealthServer(workerHealthPort(), id);

  closeOnShutdown(async () => {
    markStopping();
    if (!bootState().draining) await drain("SIGTERM");
    await beat();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  if (!(await awaitBoot("Waiting for the database schema", assertSchemaCurrent))) return;

  const { loadFeatureFlags } = await import("@/lib/config/features");
  await loadFeatureFlags().catch((err) => log.warn("Failed to load feature flags:", err));
  const { detectHost } = await import("@/lib/resources/host");
  await detectHost();
  // Web refreshes the EOL table; the digest and image-update loops here read it.
  const { loadStoredEolTable } = await import("@/lib/docker/image-updates/eol-sync");
  await loadStoredEolTable();
  // Collectors live on vardo-monitoring.
  const { ensureMonitoringNetwork } = await import("@/lib/infra/monitoring-network");
  await ensureMonitoringNetwork();
  const { startBackupWorkBeacon } = await import("@/lib/backups/in-flight");
  startBackupWorkBeacon();

  const { getBuildSha } = await import("@/lib/version");
  const registered = await awaitBoot("Registering the worker", async () =>
    registerWorker({ id, role: "all", slot: await ownSlot(), gitSha: getBuildSha() || null }),
  );
  if (!registered) return;
  setInterval(() => void beat(), WORKER_BEAT_MS).unref();

  await startLoops({ role: "worker" });
  if (bootState().stopping) return;
  markBooted();
  await beat();
  log.info(`Worker ${id} ready`);
}

main().catch((err) => crash("Boot failed", err));
