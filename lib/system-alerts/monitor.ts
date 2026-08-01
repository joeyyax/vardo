import { getSystemHealth } from "@/lib/config/health";
import { emit } from "@/lib/notifications/dispatch";
import type { BusEvent } from "@/lib/bus";
import { shouldFire, markFired, loadAlertState } from "./state";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { exec } from "child_process";
import { promisify } from "util";
import pLimit from "p-limit";
import { logger } from "@/lib/logger";
import { probeCertificate } from "./cert-probe";
import {
  evaluateCertExpiry,
  certVerdictAlerts,
  certAlertMessage,
  groupByCertificate,
  type CertVerdict,
} from "./cert-expiry";

const log = logger.child("system-alerts");

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getAllOrgIds(): Promise<string[]> {
  try {
    const orgs = await db.query.organizations.findMany({
      columns: { id: true },
    });
    return orgs.map((o) => o.id);
  } catch {
    return [];
  }
}

async function emitAll(event: BusEvent): Promise<void> {
  const orgIds = await getAllOrgIds();
  const results = await Promise.allSettled(
    orgIds.map((orgId) => { emit(orgId, event); }),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      log.error("emitAll error:", result.reason);
    }
  }
}

// ---------------------------------------------------------------------------
// Service health check — alert on healthy → unhealthy transitions
// ---------------------------------------------------------------------------

const previousServiceStatus = new Map<string, "healthy" | "unhealthy" | "unconfigured">();
const unhealthyStreak = new Map<string, number>();

async function checkServiceAlerts(health: Awaited<ReturnType<typeof getSystemHealth>>): Promise<void> {
  try {
    for (const service of health.services) {
      const prev = previousServiceStatus.get(service.name);
      previousServiceStatus.set(service.name, service.status);

      // Track consecutive unhealthy checks — require 3 in a row to filter
      // out brief blips during deploys or container restarts.
      if (service.status === "unhealthy") {
        unhealthyStreak.set(service.name, (unhealthyStreak.get(service.name) ?? 0) + 1);
      } else {
        unhealthyStreak.set(service.name, 0);
      }

      const streak = unhealthyStreak.get(service.name) ?? 0;

      // Only alert after 3 consecutive unhealthy checks (~3 min) and
      // skip when prev is undefined (first check after startup).
      if (service.status === "unhealthy" && prev !== undefined && streak >= 3) {
        if (!shouldFire("service-degraded", service.name)) continue;
        markFired("service-degraded", service.name);

        await emitAll({
          type: "system.service-down",
          title: `Service degraded: ${service.name}`,
          message: `${service.name} (${service.description}) is no longer responding. Check system health for details.`,
          service: service.name,
          description: service.description,
          latencyMs: service.latencyMs?.toString() ?? "",
        });
      }
    }
  } catch (err) {
    log.error("Service check error:", err);
  }
}

// ---------------------------------------------------------------------------
// Disk space — alert at 95%, 90%, 85% thresholds (highest severity first)
// ---------------------------------------------------------------------------

const DISK_THRESHOLDS = [95, 90, 85];

async function checkDiskAlerts(health: Awaited<ReturnType<typeof getSystemHealth>>): Promise<void> {
  try {
    const disk = health.resources.find((r) => r.name === "Disk");
    if (!disk) return;

    for (const threshold of DISK_THRESHOLDS) {
      if (disk.percent >= threshold) {
        const key = `disk-${threshold}`;
        if (!shouldFire("disk-space", key)) continue;
        markFired("disk-space", key);

        const isCritical = threshold >= 95;
        await emitAll({
          type: "system.disk-alert",
          title: `Disk usage at ${Math.round(disk.percent)}%`,
          message: `Vardo disk usage has reached ${Math.round(disk.percent)}% (threshold: ${threshold}%). Free up space to prevent service disruption.`,
          percent: disk.percent,
          threshold,
          severity: isCritical ? "critical" : "warning",
          used: disk.current,
          total: disk.total,
        });
        // Only fire the highest triggered threshold per cycle
        break;
      }
    }
  } catch (err) {
    log.error("Disk check error:", err);
  }
}

// ---------------------------------------------------------------------------
// Restart detection
// ---------------------------------------------------------------------------

// Process-level flag: only evaluate once per process lifetime to prevent
// hot-reload false positives. process.uptime() resets on Next.js hot reload,
// which would otherwise re-trigger the alert on every dev restart.
let startupCheckDone = false;

async function checkHostRestart(): Promise<void> {
  if (startupCheckDone) return;
  startupCheckDone = true;

  try {
    const uptimeSeconds = process.uptime();
    // Use a 5-minute guard to avoid false positives from slow cold starts
    // or environments where the process may take time to initialize.
    if (uptimeSeconds >= 300) return;

    // Check if we've tracked a previous uptime — if no record, this is truly
    // the first startup; skip alert
    const setting = await db.query.systemSettings.findFirst({
      where: (t, { eq }) => eq(t.key, "last_known_uptime"),
    });

    if (!setting) {
      // First time ever — record but don't alert
      await db
        .insert(systemSettings)
        .values({ key: "last_known_uptime", value: Date.now().toString() })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: Date.now().toString(), updatedAt: new Date() },
        });
      return;
    }

    if (!shouldFire("host-restarted", "host")) return;
    markFired("host-restarted", "host");

    await emitAll({
      type: "system.restart-loop",
      title: "Vardo restarted",
      message: `The Vardo process restarted. Current uptime: ${Math.round(uptimeSeconds)}s. All services are reinitializing.`,
      uptimeSeconds,
    });
  } catch (err) {
    log.error("Restart check error:", err);
  }

  // Always update last_known_uptime
  try {
    await db
      .insert(systemSettings)
      .values({ key: "last_known_uptime", value: Date.now().toString() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: Date.now().toString(), updatedAt: new Date() },
      });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Certificate expiry — dial each domain over TLS and read the served cert
// ---------------------------------------------------------------------------

// Expiry moves by one day per day, so a 60s tick would re-dial every domain
// 1440 times for the same answer.
const CERT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CERT_PROBE_CONCURRENCY = 5;

let lastCertCheck = 0;

function isProbeableDomain(domain: string): boolean {
  const host = domain.split(":")[0].toLowerCase();
  if (host === "" || !host.includes(".")) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  return true;
}

async function checkCertAlerts(): Promise<void> {
  if (Date.now() - lastCertCheck < CERT_CHECK_INTERVAL_MS) return;
  lastCertCheck = Date.now();

  try {
    const rows = await db.query.domains.findMany({
      columns: { domain: true, certResolver: true, sslEnabled: true },
      with: { app: { columns: { status: true } } },
    });

    const targets = rows.filter(
      (d) => d.sslEnabled !== false && d.app.status === "active" && isProbeableDomain(d.domain),
    );
    if (targets.length === 0) return;

    const limit = pLimit(CERT_PROBE_CONCURRENCY);

    const probed = await Promise.all(
      targets.map((d) =>
        limit(async () => {
          const probe = await probeCertificate(d.domain);
          return {
            domain: d.domain,
            resolver: d.certResolver ?? "unknown",
            fingerprint: probe.status === "ok" ? probe.fingerprint : null,
            verdict: evaluateCertExpiry(probe, Date.now()),
          };
        }),
      ),
    );

    const failing = probed.filter((p) => {
      if (certVerdictAlerts(p.verdict)) return true;
      if (p.verdict.kind === "unknown" || p.verdict.kind === "not-issued") {
        log.debug(`Cert check skipped for ${p.domain}: ${p.verdict.kind} (${p.verdict.reason})`);
      }
      return false;
    });

    for (const group of groupByCertificate(failing).values()) {
      const domains = group.map((g) => g.domain).sort();
      const verdict = group[0].verdict as Extract<CertVerdict, { kind: "expiring" | "expired" }>;

      if (!shouldFire("cert-expiring", domains[0])) continue;
      markFired("cert-expiring", domains[0]);

      const { title, message } = certAlertMessage(domains, verdict);
      await emitAll({
        type: "system.cert-expiring",
        title,
        message,
        domain: domains[0],
        domains,
        daysLeft: verdict.daysLeft,
        expiresAt: verdict.expiresAt,
        resolver: group[0].resolver,
      });
    }
  } catch (err) {
    log.error("Cert check error:", err);
  }
}

// ---------------------------------------------------------------------------
// Update available — check git remote
// ---------------------------------------------------------------------------

async function checkUpdateAlert(): Promise<void> {
  try {
    const [remoteResult, localResult] = await Promise.all([
      execAsync("git ls-remote origin HEAD 2>/dev/null", { timeout: 10_000 }),
      execAsync("git rev-parse HEAD 2>/dev/null", { timeout: 5_000 }),
    ]);

    const remoteHead = remoteResult.stdout.split("\t")[0].trim();
    const localHead = localResult.stdout.trim();

    if (!remoteHead || !localHead) return;
    if (remoteHead === localHead) return;

    if (!shouldFire("update-available", "main")) return;
    markFired("update-available", "main");

    await emitAll({
      type: "system.update-available",
      title: "Vardo update available",
      message: `A new version of Vardo is available. Remote: ${remoteHead.slice(0, 8)} — Local: ${localHead.slice(0, 8)}. Pull and redeploy when ready.`,
      remoteHead: remoteHead.slice(0, 8),
      localHead: localHead.slice(0, 8),
    });
  } catch {
    // git not available or no remote — best-effort
  }
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

export async function tickSystemAlerts(): Promise<void> {
  // Fetch health once and share the result across checks that need it.
  // This avoids duplicate getSystemHealth() calls per tick.
  let health: Awaited<ReturnType<typeof getSystemHealth>> | null = null;
  try {
    health = await getSystemHealth();
  } catch (err) {
    log.error("Health fetch error:", err);
  }

  const checks: Promise<void>[] = [checkHostRestart(), checkCertAlerts(), checkUpdateAlert()];

  if (health) {
    checks.push(checkServiceAlerts(health), checkDiskAlerts(health));
  }

  await Promise.allSettled(checks);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let interval: NodeJS.Timeout | null = null;
let ticking = false;

export function startSystemAlertMonitor(): void {
  if (interval) return;

  // Load persisted alert state from DB before the first tick so rate-limit
  // windows survive process restarts. Defer the initial tick by 10s to let
  // the process stabilize before firing network calls (git ls-remote, etc.).
  loadAlertState()
    .then(() => {
      setTimeout(() => {
        tickSystemAlerts().catch((err) => {
          log.error("Initial tick error:", err);
        });
      }, 10_000);
    })
    .catch((err) => {
      log.error("Failed to load alert state:", err);
    });

  log.info("Monitor started (60s interval)");
  interval = setInterval(async () => {
    if (ticking) {
      log.warn("Previous tick still running — skipping");
      return;
    }
    ticking = true;
    try {
      await tickSystemAlerts();
    } catch (err) {
      log.error("Tick error:", err);
    } finally {
      ticking = false;
    }
  }, 60_000);
}

export function stopSystemAlertMonitor(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Monitor stopped");
  }
}

// ---------------------------------------------------------------------------
// Process shutdown hook
// ---------------------------------------------------------------------------

// Wire cleanup on process exit so the monitor is always stopped cleanly.
// This covers SIGTERM (Docker stop, systemd), SIGINT (Ctrl-C), and normal exit.
// Note: SIGUSR2 is not handled here — if you use it for hot reloads (e.g.
// nodemon) call stopSystemAlertMonitor() in your reload handler manually.
function onShutdown(signal: string) {
  log.info(`Received ${signal} — stopping monitor`);
  stopSystemAlertMonitor();
}

process.once("SIGTERM", () => onShutdown("SIGTERM"));
process.once("SIGINT", () => onShutdown("SIGINT"));
process.once("exit", () => stopSystemAlertMonitor());
