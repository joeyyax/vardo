import { getSystemHealth } from "@/lib/config/health";
import { emit } from "@/lib/notifications/dispatch";
import type { BusEvent } from "@/lib/bus";
import { shouldFire, markFired, clearFired, loadAlertState } from "./state";
import { db } from "@/lib/db";
import { domainCertChecks, systemSettings } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { getCommitUpdate } from "@/lib/version";
import pLimit from "p-limit";
import { logger } from "@/lib/logger";
import { closeOnShutdown } from "@/lib/shutdown";
import { probeCertificate } from "./cert-probe";
import {
  evaluateCertExpiry,
  certVerdictAlerts,
  certAlertMessage,
  groupByCertificate,
  type CertVerdict,
} from "./cert-expiry";
import { readFile } from "fs/promises";
import {
  WATCHDOG_EVENTS_FILE,
  WATCHDOG_CURSOR_KEY,
  FIRST_READ_LOOKBACK_S,
  newWatchdogEvents,
  describeWatchdogEvent,
} from "./watchdog-events";

const log = logger.child("system-alerts");

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

// Service health: alert on healthy → unhealthy transitions.

const previousServiceStatus = new Map<string, "healthy" | "unhealthy" | "unconfigured">();
const unhealthyStreak = new Map<string, number>();

async function checkServiceAlerts(health: Awaited<ReturnType<typeof getSystemHealth>>): Promise<void> {
  try {
    for (const service of health.services) {
      const prev = previousServiceStatus.get(service.name);
      previousServiceStatus.set(service.name, service.status);

      // Require 3 unhealthy checks in a row to filter out deploy blips.
      if (service.status === "unhealthy") {
        unhealthyStreak.set(service.name, (unhealthyStreak.get(service.name) ?? 0) + 1);
      } else {
        // Not gated on the in-memory streak, which resets on boot and would strand a pre-restart alert.
        clearFired("service-degraded", service.name);
        unhealthyStreak.set(service.name, 0);
      }

      const streak = unhealthyStreak.get(service.name) ?? 0;

      // Skip when prev is undefined (first check after startup).
      if (service.status === "unhealthy" && prev !== undefined && streak >= 3) {
        if (!shouldFire("service-degraded", service.name)) continue;
        markFired("service-degraded", service.name);

        await emitAll({
          type: "system.service-down",
          title: `Service degraded: ${service.name}`,
          message: `${service.name} (${service.description}) is no longer responding.`,
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

// Disk space: alert at 95%, 90% and 85%, highest first.

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
        break;
      }
    }
  } catch (err) {
    log.error("Disk check error:", err);
  }
}

// Restarts are announced by lib/lifecycle/monitor.ts.

// Certificate expiry: dial each domain over TLS and read the served cert.
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

type ProbedDomain = {
  domainId: string;
  domain: string;
  fingerprint: string | null;
  verdict: CertVerdict;
};

/** Stores the latest observation per domain for app conditions. Best-effort; a failed write must not cost the alert. */
async function recordCertObservations(probed: ProbedDomain[]): Promise<void> {
  if (probed.length === 0) return;
  const checkedAt = new Date();
  const values = probed.map((p) => ({
    domainId: p.domainId,
    expiresAt:
      p.verdict.kind === "not-issued" || p.verdict.kind === "unknown"
        ? null
        : new Date(p.verdict.expiresAt),
    fingerprint: p.fingerprint,
    status: p.verdict.kind,
    checkedAt,
  }));

  try {
    await db
      .insert(domainCertChecks)
      .values(values)
      .onConflictDoUpdate({
        target: domainCertChecks.domainId,
        set: {
          expiresAt: sql`excluded.expires_at`,
          fingerprint: sql`excluded.fingerprint`,
          status: sql`excluded.status`,
          checkedAt: sql`excluded.checked_at`,
        },
      });
  } catch (err) {
    log.error("Cert observation write error:", err);
  }
}

async function checkCertAlerts(): Promise<void> {
  if (Date.now() - lastCertCheck < CERT_CHECK_INTERVAL_MS) return;
  lastCertCheck = Date.now();

  try {
    const rows = await db.query.domains.findMany({
      columns: { id: true, domain: true, certResolver: true, sslEnabled: true },
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
            domainId: d.id,
            domain: d.domain,
            resolver: d.certResolver ?? "unknown",
            fingerprint: probe.status === "ok" ? probe.fingerprint : null,
            verdict: evaluateCertExpiry(probe, Date.now()),
          };
        }),
      ),
    );

    await recordCertObservations(probed);

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

// Watchdog: surface restarts scripts/watchdog.sh made while the console couldn't.

export async function checkWatchdogEvents(): Promise<void> {
  let text: string;
  try {
    text = await readFile(WATCHDOG_EVENTS_FILE, "utf-8");
  } catch {
    return;
  }
  try {
    const row = await db.query.systemSettings.findFirst({
      where: (t, { eq }) => eq(t.key, WATCHDOG_CURSOR_KEY),
    });
    const since = row ? Number(row.value) || 0 : Math.floor(Date.now() / 1000) - FIRST_READ_LOOKBACK_S;
    const events = newWatchdogEvents(text, since);
    if (events.length === 0) return;

    const cursor = String(events[events.length - 1].ts);
    await db
      .insert(systemSettings)
      .values({ key: WATCHDOG_CURSOR_KEY, value: cursor })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: cursor, updatedAt: new Date() } });

    for (const event of events) {
      const { title, message } = describeWatchdogEvent(event);
      log.warn(title);
      await emitAll({
        type: "system.service-down",
        title,
        message,
        service: event.container,
        description: `watchdog ${event.action}`,
      });
    }
  } catch (err) {
    log.error("Watchdog event check error:", err);
  }
}

// Update available: compare the build commit to main on GitHub.

export async function checkUpdateAlert(): Promise<void> {
  try {
    const update = await getCommitUpdate();
    if (!update?.hasUpdate) return;

    if (!shouldFire("update-available", "main")) return;
    markFired("update-available", "main");

    const remoteHead = update.remoteSha.slice(0, 8);
    const localHead = update.localSha.slice(0, 8);
    await emitAll({
      type: "system.update-available",
      title: "Vardo update available",
      message: `A new version of Vardo is available. Remote: ${remoteHead} — Local: ${localHead}. Run vardo update when ready.`,
      remoteHead,
      localHead,
    });
  } catch (err) {
    log.debug("Update check error:", err);
  }
}

export async function tickSystemAlerts(): Promise<void> {
  // Fetch health once per tick and share it.
  let health: Awaited<ReturnType<typeof getSystemHealth>> | null = null;
  try {
    health = await getSystemHealth();
  } catch (err) {
    log.error("Health fetch error:", err);
  }

  const checks: Promise<void>[] = [checkCertAlerts(), checkUpdateAlert(), checkWatchdogEvents()];

  if (health) {
    checks.push(checkServiceAlerts(health), checkDiskAlerts(health));
  }

  await Promise.allSettled(checks);
}

let interval: NodeJS.Timeout | null = null;
let ticking = false;
let unregisterShutdown: (() => void) | null = null;

export function startSystemAlertMonitor(): void {
  if (interval) return;

  // Load persisted alert state before the first tick so rate-limit windows survive restarts.
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

  // Registered here, not at module scope, so importing doesn't wire a shutdown.
  unregisterShutdown = closeOnShutdown(stopSystemAlertMonitor);
}

export function stopSystemAlertMonitor(): void {
  unregisterShutdown?.();
  unregisterShutdown = null;
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Monitor stopped");
  }
}
