import { getSystemHealth } from "@/lib/config/health";
import { notify } from "@/lib/notifications/dispatch";
import { shouldFire, markFired, loadAlertState } from "./state";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { exec } from "child_process";
import { promisify } from "util";

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

async function notifyAll(event: Parameters<typeof notify>[1]): Promise<void> {
  const orgIds = await getAllOrgIds();
  const results = await Promise.allSettled(
    orgIds.map((orgId) => notify(orgId, event)),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[system-alerts] notifyAll error:", result.reason);
    }
  }
}

// ---------------------------------------------------------------------------
// Service health check — alert on healthy → unhealthy transitions
// ---------------------------------------------------------------------------

const previousServiceStatus = new Map<string, "healthy" | "unhealthy" | "unconfigured">();

async function checkServiceAlerts(health: Awaited<ReturnType<typeof getSystemHealth>>): Promise<void> {
  try {
    for (const service of health.services) {
      const prev = previousServiceStatus.get(service.name);
      previousServiceStatus.set(service.name, service.status);

      // Only alert on healthy → unhealthy transitions
      if (service.status === "unhealthy" && prev === "healthy") {
        if (!shouldFire("service-degraded", service.name)) continue;
        markFired("service-degraded", service.name);

        await notifyAll({
          type: "system-alert-service",
          title: `Service degraded: ${service.name}`,
          message: `${service.name} (${service.description}) is no longer responding. Check system health for details.`,
          metadata: {
            service: service.name,
            description: service.description,
            latencyMs: service.latencyMs?.toString() ?? "",
          },
        });
      }
    }
  } catch (err) {
    console.error("[system-alerts] Service check error:", err);
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
        await notifyAll({
          type: "system-alert-disk",
          title: `Disk usage at ${Math.round(disk.percent)}%`,
          message: `Host disk usage has reached ${Math.round(disk.percent)}% (threshold: ${threshold}%). Free up space to prevent service disruption.`,
          metadata: {
            percent: disk.percent.toString(),
            threshold: threshold.toString(),
            severity: isCritical ? "critical" : "warning",
            used: disk.current.toString(),
            total: disk.total.toString(),
          },
        });
        // Only fire the highest triggered threshold per cycle
        break;
      }
    }
  } catch (err) {
    console.error("[system-alerts] Disk check error:", err);
  }
}

// ---------------------------------------------------------------------------
// Host restart detection
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

    await notifyAll({
      type: "system-alert-restart",
      title: "Host restarted",
      message: `The host process restarted. Current uptime: ${Math.round(uptimeSeconds)}s. All services are reinitializing.`,
      metadata: {
        uptimeSeconds: uptimeSeconds.toString(),
      },
    });
  } catch (err) {
    console.error("[system-alerts] Host restart check error:", err);
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
// Certificate expiry — check Traefik TLS routers
// ---------------------------------------------------------------------------

type TraefikRouter = {
  name: string;
  tls?: {
    certResolver?: string;
    domains?: Array<{ main?: string; sans?: string[] }>;
  };
  rule?: string;
};

async function checkCertAlerts(): Promise<void> {
  try {
    const res = await fetch("http://localhost:8080/api/http/routers", {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;

    const routers: TraefikRouter[] = await res.json();

    // Collect unique cert resolvers to avoid redundant ACME endpoint calls
    const resolvers = new Set<string>();
    for (const router of routers) {
      if (router.tls?.certResolver) resolvers.add(router.tls.certResolver);
    }

    for (const resolver of resolvers) {
      // Best-effort: try ACME store via undocumented endpoint
      try {
        const acmeRes = await fetch(
          `http://localhost:8080/api/acme/${resolver}/domains`,
          { signal: AbortSignal.timeout(3000) },
        );

        if (acmeRes.ok) {
          type AcmeDomain = {
            domain?: { main?: string };
            certificate?: { notAfter?: string };
          };
          const acmeDomains: AcmeDomain[] = await acmeRes.json();

          for (const acmeDomain of acmeDomains) {
            const certDomain = acmeDomain.domain?.main;
            if (!certDomain) continue;

            const notAfterStr = acmeDomain.certificate?.notAfter;
            if (!notAfterStr) continue;

            const notAfter = new Date(notAfterStr);
            const daysLeft = (notAfter.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

            if (daysLeft < 7) {
              if (!shouldFire("cert-expiring", certDomain)) continue;
              markFired("cert-expiring", certDomain);

              await notifyAll({
                type: "system-alert-cert",
                title: `Certificate expiring: ${certDomain}`,
                message: `The TLS certificate for ${certDomain} expires in ${Math.round(daysLeft)} day(s). Traefik should auto-renew — check logs if renewal is not happening.`,
                metadata: {
                  domain: certDomain,
                  daysLeft: Math.round(daysLeft).toString(),
                  expiresAt: notAfter.toISOString(),
                  resolver: resolver,
                },
              });
            }
          }
        }
      } catch {
        // cert check best-effort per resolver
      }
    }
  } catch {
    // Traefik may not be running — best-effort
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

    await notifyAll({
      type: "system-alert-update",
      title: "Host update available",
      message: `A new version of Host is available. Remote: ${remoteHead.slice(0, 8)} — Local: ${localHead.slice(0, 8)}. Pull and redeploy when ready.`,
      metadata: {
        remoteHead: remoteHead.slice(0, 8),
        localHead: localHead.slice(0, 8),
      },
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
    console.error("[system-alerts] Health fetch error:", err);
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
          console.error("[system-alerts] Initial tick error:", err);
        });
      }, 10_000);
    })
    .catch((err) => {
      console.error("[system-alerts] Failed to load alert state:", err);
    });

  console.log("[system-alerts] Monitor started (60s interval)");
  interval = setInterval(async () => {
    if (ticking) {
      console.warn("[system-alerts] Previous tick still running — skipping");
      return;
    }
    ticking = true;
    try {
      await tickSystemAlerts();
    } catch (err) {
      console.error("[system-alerts] Tick error:", err);
    } finally {
      ticking = false;
    }
  }, 60_000);
}

export function stopSystemAlertMonitor(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    console.log("[system-alerts] Monitor stopped");
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
  console.log(`[system-alerts] Received ${signal} — stopping monitor`);
  stopSystemAlertMonitor();
}

process.once("SIGTERM", () => onShutdown("SIGTERM"));
process.once("SIGINT", () => onShutdown("SIGINT"));
process.once("exit", () => stopSystemAlertMonitor());
