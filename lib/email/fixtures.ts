// Realistic events for the email preview and template tests.

import type { AlertItem, BackupSummaryEvent, BusEvent } from "@/lib/bus/events";
import { summarizeApps, summarizeResults, volumeKey, type BackupResultItem } from "@/lib/backups/run-rules";
import type { MailContext, MailSeries } from "./templates/context";

export const FIXTURE_CONTEXT: MailContext = {
  baseUrl: "https://vardo.example.com",
  instanceName: "node-a",
  orgName: "Acme Studio",
};

const timings = (ms: Partial<Record<"clone" | "build" | "pull" | "up" | "healthWait" | "cleanup", number>>) =>
  Object.fromEntries(
    Object.entries(ms).map(([phase, value]) => [
      phase,
      { startedAt: "2026-10-09T17:00:00.000Z", endedAt: "2026-10-09T17:00:00.000Z", ms: value },
    ]),
  );

const GiB = 1024 ** 3;

/** A gentle 24-point curve from `start` to `end` with some noise. */
function ramp(start: number, end: number, wobble = 0.02): number[] {
  return Array.from({ length: 24 }, (_, i) => {
    const t = i / 23;
    return Math.round((start + (end - start) * t) * (1 + Math.sin(i * 1.7) * wobble));
  });
}

const hostMemory: AlertItem = {
  type: "host.memory",
  about: "host",
  severity: "warning",
  title: "Memory 91% used",
  detail: "Available memory is low. Deploys can fail and the kernel starts killing containers. Stop or limit what's using it.",
  gauge: { title: "Memory used", percent: 91.4, warn: 85, critical: 95 },
  series: { title: "Memory, last hour", values: ramp(72, 92, 0.03).slice(-20), caption: "Over 85% for 5 min" },
  facts: [
    { label: "Used", value: "29.2 GiB of 31.9 GiB" },
    { label: "Available", value: "2.7 GiB" },
    { label: "Top containers", value: "shop-production-blue-wordpress-1 6.1 GiB, search-data-production-green-meilisearch-1 4.8 GiB, vardo-postgres 2.2 GiB" },
  ],
};

const hostDisk: AlertItem = {
  type: "host.disk",
  about: "host",
  severity: "warning",
  title: "Disk 91% full",
  detail: "Deploys and backups fail once the disk is full. Prune old images and build cache or grow the disk.",
  gauge: { title: "Disk used", percent: 91.3, warn: 85, critical: 95 },
  facts: [
    { label: "Used", value: "204.0 GiB of 223.4 GiB" },
    { label: "Free", value: "19.4 GiB" },
  ],
};

const MiB = 1024 ** 2;

/** A night of backups, one result per app and volume. */
const NIGHTLY: BackupResultItem[] = [
  ["app_shop", "Shop", "mysql-data", 1_932 * MiB],
  ["app_shop", "Shop", "wp-content", 6_240 * MiB],
  ["app_acme", "Acme Data", "uploads", 480 * MiB],
  ["app_acme", "Acme Data", "postgres-data", 212 * MiB],
  ["app_srch", "Search", "meili-data", 1_104 * MiB],
  ["app_kuma", "Uptime Kuma", "kuma-data", 38 * MiB],
].map(([appId, appName, volumeName, sizeBytes], i) => ({
  kind: "backup" as const,
  appId: appId as string,
  appName: appName as string,
  volumeName: volumeName as string,
  jobName: `auto-${appId}`,
  outcome: "success" as const,
  sizeBytes: sizeBytes as number,
  durationMs: 20_000 + i * 9_000,
  at: `2026-10-09T02:${String(2 + i * 4).padStart(2, "0")}:00.000Z`,
}));

/** Six earlier runs per volume, each a touch smaller than tonight. */
const NIGHTLY_HISTORY = new Map(
  NIGHTLY.map((i) => [volumeKey(i.appId, i.volumeName), [0.94, 0.95, 0.96, 0.97, 0.98, 0.99].map((f) => Math.round(i.sizeBytes! * f))]),
);

/** Observability's volumes: Loki and Prometheus jumped, Redis grew a little. [volume, tonight, last run]. */
const OBSERVABILITY_SIZES: [string, number, number][] = [
  ["loki-data", 532.6 * MiB, 1.71 * MiB],
  ["prometheus-data", 71.8 * MiB, 21.06 * MiB],
  ["grafana-data", 12.4 * MiB, 12.3 * MiB],
  ["redis-data", 0.82 * MiB, 0.44 * MiB],
];

const OBSERVABILITY: BackupResultItem[] = OBSERVABILITY_SIZES.map(([volumeName, sizeBytes], i) => ({
  kind: "backup" as const,
  appId: "app_0bs",
  appName: "Observability",
  volumeName,
  jobName: "Auto: Observability",
  outcome: "success" as const,
  sizeBytes: Math.round(sizeBytes),
  durationMs: 8_000 + i * 3_000,
  at: `2026-10-09T02:${String(3 + i).padStart(2, "0")}:00.000Z`,
}));

const HISTORY = new Map([
  ...NIGHTLY_HISTORY,
  ...OBSERVABILITY_SIZES.map(([volumeName, , last]): [string, number[]] => [
    volumeKey("app_0bs", volumeName),
    [0.97, 0.98, 0.99, 1].map((f) => Math.round(last * f)),
  ]),
]);

function backupSummary(items: BackupResultItem[], extra: Partial<BackupSummaryEvent>): BackupSummaryEvent {
  const rows = summarizeResults(items, HISTORY);
  const backups = rows.filter((r) => r.kind === "backup");
  return {
    type: "backup.summary",
    title: "Nightly backups finished",
    message: `${backups.filter((r) => r.outcome === "success").length} of ${backups.length} backups succeeded.`,
    run: { kind: "nightly", label: "Nightly backups", estimatedMs: 33 * 60_000, actualMs: 41 * 60_000 },
    windowStart: "2026-10-09T02:00:00.000Z",
    windowEnd: "2026-10-09T02:41:00.000Z",
    succeeded: backups.filter((r) => r.outcome === "success").length,
    failed: backups.filter((r) => r.outcome === "failed").length,
    skipped: backups.filter((r) => r.outcome === "skipped").length,
    totalSize: backups.reduce((sum, r) => sum + (r.outcome === "success" ? r.sizeBytes : 0), 0),
    durationMs: backups.reduce((sum, r) => sum + r.durationMs, 0),
    rows,
    apps: summarizeApps(rows),
    ...extra,
  };
}

export const EMAIL_FIXTURES: { name: string; event: BusEvent; series?: MailSeries }[] = [
  {
    name: "deploy-success",
    event: {
      type: "deploy.success",
      title: "Deploy successful: acme-web",
      message: "acme-web was deployed successfully in 1m 32s.",
      projectName: "acme-web",
      appName: "acme-web",
      project: "Acme Nonprofit",
      environment: "production",
      appId: "app_9xk2",
      deploymentId: "dep_a1b2",
      duration: "92s",
      durationMs: 92_400,
      domain: "acme.example.org",
      domains: ["acme.example.org", "www.acme.example.org"],
      gitSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      gitMessage: "Fix donation form validation on mobile",
      gitAuthor: "Alex Kim",
      gitBranch: "main",
      repoUrl: "https://github.com/acme/acme-web",
      trigger: "webhook",
      slot: "green",
      previousSlot: "blue",
      stageTimings: timings({ clone: 3_200, build: 61_800, pull: 4_100, up: 6_300, healthWait: 12_400, cleanup: 2_100 }),
    },
  },
  {
    name: "deploy-failed",
    event: {
      type: "deploy.failed",
      title: "Deploy failed: search-data",
      message: "green slot did not become healthy: meilisearch crashed (crash-looping, 5 restarts). See logs above",
      projectName: "search-data",
      appName: "search-data",
      project: "Shop",
      environment: "production",
      appId: "app_s3ar",
      deploymentId: "dep_f41l",
      errorMessage: "green slot did not become healthy: meilisearch crashed (crash-looping, 5 restarts). See logs above",
      failedStage: "healthcheck",
      crashReason: "Error: Your database version (1.13.3) is incompatible with your current engine version (1.54.3).",
      trigger: "manual",
      triggeredBy: "Alex Kim",
      slot: "green",
      previousSlot: "blue",
      serving: "previous",
      durationMs: 74_000,
      stageTimings: timings({ pull: 8_200, up: 3_100, healthWait: 58_900 }),
      logTail: [
        "meilisearch-1  | 2026-10-09T17:02:11Z INFO  meilisearch: Starting Meilisearch",
        "meilisearch-1  | Error: Your database version (1.13.3) is incompatible with your current engine version (1.54.3).",
        "meilisearch-1  | To migrate data between Meilisearch versions, please follow our guide on https://www.meilisearch.com/docs/learn/update_and_migration/updating.",
        "meilisearch-1 exited with code 1 (restarting)",
        "meilisearch-1  | 2026-10-09T17:02:19Z INFO  meilisearch: Starting Meilisearch",
        "meilisearch-1  | Error: Your database version (1.13.3) is incompatible with your current engine version (1.54.3).",
        "meilisearch-1 exited with code 1 (restarting)",
      ],
    },
  },
  {
    name: "deploy-failed-build",
    event: {
      type: "deploy.failed",
      title: "Deploy failed: shop-staging",
      message: "Build failed: exit code 1",
      projectName: "Shop Staging",
      appName: "shop-staging",
      project: "Shop",
      environment: "staging",
      appId: "app_shop_staging",
      deploymentId: "dep_b0rk",
      errorMessage: "Build failed: exit code 1",
      failedStage: "build",
      gitSha: "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
      gitMessage: "Upgrade to PHP 8.4",
      gitAuthor: "Alex Kim",
      repoUrl: "https://github.com/acme/shop",
      trigger: "webhook",
      serving: "previous",
      durationMs: 48_000,
      logTail: [
        "#12 [build 4/6] RUN composer install --no-dev --optimize-autoloader",
        "#12 1.204 Your requirements could not be resolved to an installable set of packages.",
        "#12 1.205   Problem 1",
        "#12 1.205     - Root composer.json requires php ~8.2.0 but your php version (8.4.1) does not satisfy that requirement.",
        "#12 ERROR: process \"/bin/sh -c composer install --no-dev --optimize-autoloader\" did not complete successfully: exit code: 2",
        "[deploy] ERROR: Build failed: exit code 1",
      ],
    },
  },
  {
    name: "deploy-incomplete",
    event: {
      type: "deploy.incomplete",
      title: "Post-deploy work unfinished: Formbricks",
      message: "Formbricks is deployed and serving, but the old slot (blue) is still running",
      projectName: "Formbricks",
      appName: "formbricks",
      project: "Tools",
      environment: "production",
      appId: "app_f0rm",
      deploymentId: "dep_1nc0",
      slot: "green",
      domains: ["forms.example.com"],
      reason:
        "the old slot (blue) is still running — Command failed: docker compose -f /opt/vardo/apps/formbricks/production/blue/docker-compose.yml -p formbricks-production-blue stop\nError response from daemon: cannot stop container: formbricks-production-blue-formbricks-1: tried to kill container, but did not receive an exit event",
    },
  },
  {
    name: "auto-rollback",
    event: {
      type: "deploy.rollback",
      title: "Auto-rollback: acme-web",
      message: "Containers stopped within the grace period, so traffic went back to blue.",
      projectName: "acme-web",
      appId: "app_9xk2",
      deploymentId: "dep_a1b2",
      rollbackSuccess: true,
      restoredSlot: "blue",
    },
  },
  {
    name: "backup-run-started",
    event: {
      type: "backup.run-started",
      title: "Nightly backups starting",
      message: "10 volumes across 5 apps, about 33 min.",
      runId: "run_1",
      kind: "nightly",
      label: "Nightly backups",
      apps: [
        { appId: "app_acme", appName: "Acme Data", volumes: ["postgres-data", "uploads"], lastBytes: 685 * MiB },
        { appId: "app_0bs", appName: "Observability", volumes: ["grafana-data", "loki-data", "prometheus-data", "redis-data"], lastBytes: 35.5 * MiB },
        { appId: "app_srch", appName: "Search", volumes: ["meili-data"], lastBytes: 1_093 * MiB },
        { appId: "app_kuma", appName: "Uptime Kuma", volumes: ["kuma-data"] },
        { appId: "app_shop", appName: "Shop", volumes: ["mysql-data", "wp-content"], lastBytes: 8_090 * MiB },
      ],
      volumeCount: 10,
      estimatedMs: 33 * 60_000,
      target: "R2 backups · backups/apps",
    },
  },
  {
    name: "backup-failure",
    event: {
      type: "alert.fired",
      title: "Backup of Shop / mysql-data failed",
      message: "Backup of Shop / mysql-data failed",
      alerts: [
        {
          type: "backup.failure",
          about: "backup:app_shop:mysql-data",
          severity: "critical",
          title: "Backup of Shop / mysql-data failed",
          detail: "mysqldump: Got error: 2013: Lost connection to server during query. The last good backup is still there. Fix the cause, then run the job again.",
          appId: "app_shop",
          appName: "Shop",
          facts: [
            { label: "Job", value: "Auto: Shop" },
            { label: "Volume", value: "mysql-data" },
          ],
          since: "2026-10-09T02:06:00.000Z",
        },
      ],
    },
  },
  {
    name: "backup-summary",
    event: backupSummary(NIGHTLY, {}),
  },
  {
    name: "backup-summary-grew",
    event: backupSummary([...NIGHTLY, ...OBSERVABILITY], {}),
  },
  {
    name: "backup-summary-shrunk",
    event: backupSummary(
      NIGHTLY.map((i) => (i.volumeName === "mysql-data" ? { ...i, sizeBytes: 104_857_600 } : i)),
      { staleVolumes: [{ appName: "Search", volumeName: "meili-data", lastSuccessAt: "2026-10-06T07:12:00.000Z" }] },
    ),
  },
  {
    name: "backup-summary-failed",
    event: backupSummary(
      [
        ...NIGHTLY.map((i) =>
          i.volumeName === "mysql-data"
            ? { ...i, outcome: "failed" as const, sizeBytes: 0, error: "mysqldump: Got error: 2013: Lost connection to server during query" }
            : i,
        ),
        { kind: "drill", appId: "app_acme", appName: "Acme Data", volumeName: "uploads", outcome: "failed", error: "extract exited 2", durationMs: 41_000, at: "2026-10-09T02:38:00.000Z" },
        { kind: "restore", appId: "app_shop_staging", appName: "Shop Staging", volumeName: "wp-content", outcome: "success", durationMs: 74_000, at: "2026-10-09T02:31:00.000Z" },
      ],
      {},
    ),
  },
  {
    name: "cron-failed",
    event: {
      type: "cron.failed",
      title: "Cron failed: sync-orders (Shop Staging)",
      message: "PHP Fatal error: Allowed memory size of 134217728 bytes exhausted",
      cronJobId: "cron_1",
      cronJobName: "sync-orders",
      appId: "app_shop_staging",
      projectName: "Shop Staging",
      durationMs: 12_300,
      schedule: "*/15 * * * *",
      command: "wp cron event run --due-now",
      jobType: "command",
      exitCode: 255,
      target: "shop-staging-production-blue-wordpress-1",
      lastSuccessAt: "2026-10-09T16:45:00.000Z",
      logTail: [
        "Executed the cron event 'woocommerce_cleanup_sessions' in 0.012s.",
        "PHP Fatal error:  Allowed memory size of 134217728 bytes exhausted (tried to allocate 20480 bytes) in /var/www/html/wp-includes/class-wpdb.php on line 2349",
      ],
    },
  },
  {
    name: "cron-failed-exit",
    event: {
      type: "cron.failed",
      title: "Cron failed: failure test (Shop Docs)",
      message: "testing failure path",
      cronJobId: "cron_2",
      cronJobName: "failure test",
      appId: "app_d0cs",
      projectName: "Shop Docs",
      durationMs: 112,
      schedule: "* * * * *",
      command: "echo testing failure path; exit 3",
      jobType: "command",
      exitCode: 3,
      target: "shop-docs-production-green-web-1",
      logTail: ["testing failure path"],
    },
  },
  {
    name: "disk-write-alert",
    event: {
      type: "disk.write-alert",
      title: "High disk writes: MySQL",
      message: "App 'MySQL' wrote 7.7 GiB in the last hour (threshold: 4 GiB)",
      appId: "app_my5q",
      appName: "MySQL",
      projectName: "Shop Staging",
      composeService: "mysql",
      dataEngine: true,
      containerName: "shop-staging-data-production-blue-shop-staging-mysql-1",
      containerId: "c0ffee",
      writtenBytes: 8_270_499_840,
      thresholdBytes: 4_294_967_296,
      window: "1h",
      metricsProject: "shop-staging-data",
    },
    series: {
      diskWritesHourly: [
        0.3, 0.2, 0.2, 0.3, 0.4, 0.3, 0.2, 0.2, 0.3, 0.5, 0.6, 0.4, 0.3, 0.3, 0.4, 0.3, 0.2, 0.3, 0.4, 1.1, 3.2, 5.6, 6.9, 7.7,
      ].map((g) => Math.round(g * GiB)),
    },
  },
  {
    name: "volume-drift",
    event: {
      type: "volume.drift",
      title: "Volume drift detected: shop-staging",
      message: "14 unignored file change(s) detected",
      appId: "app_shop_staging",
      appName: "Shop Staging",
      totalDrift: 14,
      volumes: [
        { name: "wp-content", modified: 9, added: 3, missing: 0 },
        { name: "uploads", modified: 0, added: 0, missing: 2 },
      ],
    },
  },
  {
    name: "alert-host-disk",
    event: {
      type: "alert.fired",
      title: "Disk 91% full",
      message: "Disk 91% full",
      alerts: [
        {
          ...hostDisk,
        },
      ],
    },
    series: { dockerDisk24h: ramp(141 * GiB, 163 * GiB, 0.01) },
  },
  {
    name: "alert-host-memory",
    event: {
      type: "alert.fired",
      title: "Memory 91% used",
      message: "Memory 91% used",
      alerts: [hostMemory],
    },
  },
  {
    name: "alert-coalesced",
    event: {
      type: "alert.fired",
      title: "3 alerts: Shop was killed for memory and more",
      message: "Shop was killed for memory; Search was killed for memory; Memory 97% used",
      alerts: [
        {
          type: "app.oom",
          about: "app_shop",
          appId: "app_shop",
          appName: "Shop",
          severity: "critical",
          title: "Shop was killed for memory",
          detail: "The host ran out of memory and the kernel killed it. Free memory on the host or give the app a limit.",
          facts: [
            { label: "Kills", value: "2" },
            { label: "Container", value: "shop-production-blue-wordpress-1 (2)" },
          ],
          since: "2026-10-09T14:02:11.000Z",
        },
        {
          type: "app.oom",
          about: "app_srch",
          appId: "app_srch",
          appName: "Search",
          severity: "critical",
          title: "Search was killed for memory",
          detail: "The host ran out of memory and the kernel killed it. Free memory on the host or give the app a limit.",
          facts: [
            { label: "Kills", value: "1" },
            { label: "Container", value: "search-data-production-green-meilisearch-1" },
          ],
          since: "2026-10-09T14:02:40.000Z",
        },
        { ...hostMemory, severity: "critical", title: "Memory 97% used", gauge: { ...hostMemory.gauge!, percent: 97.2 } },
      ],
    },
  },
  {
    name: "alert-resolved",
    event: {
      type: "alert.resolved",
      title: "2 alerts resolved",
      message: "Memory 91% used; Shop is near its memory limit",
      alerts: [
        { ...hostMemory, firedAt: "2026-10-09T14:05:00.000Z", resolvedAt: "2026-10-09T14:41:00.000Z" },
        {
          type: "app.memory-limit",
          about: "app_shop",
          appId: "app_shop",
          appName: "Shop",
          severity: "warning",
          title: "Shop is near its memory limit",
          detail: "It has stayed over 90% of its limit for 10 minutes.",
          since: "2026-10-09T13:50:00.000Z",
          firedAt: "2026-10-09T14:00:00.000Z",
          resolvedAt: "2026-10-09T14:41:00.000Z",
        },
      ],
    },
  },
  {
    name: "system-service-down",
    event: {
      type: "system.service-down",
      title: "Service degraded: redis",
      message: "redis (Cache and queues) is no longer responding.",
      service: "redis",
      description: "Cache and queues",
      latencyMs: "5003",
    },
  },
  {
    name: "system-cert-expiring",
    event: {
      type: "system.cert-expiring",
      title: "Certificate expiring: acme.example.org",
      message: "The certificate for acme.example.org and www.acme.example.org expires in 6 days and hasn't renewed.",
      domain: "acme.example.org",
      domains: ["acme.example.org", "www.acme.example.org"],
      daysLeft: 6,
      expiresAt: "2026-10-15T12:00:00.000Z",
      resolver: "le",
    },
  },
  {
    name: "digest-weekly",
    event: {
      type: "digest.health",
      title: "Weekly health summary: Acme Studio",
      message: "48 deploys, 3 failed.",
      cadence: "weekly",
      orgName: "Acme Studio",
      windowLabel: "Oct 5 – Oct 11, 2026",
      since: "2026-10-05T00:00:00.000Z",
      until: "2026-10-12T00:00:00.000Z",
      deploys: { total: 48, succeeded: 45, failed: 3 },
      deploysByBucket: [
        [5, 1], [9, 0], [12, 2], [3, 0], [8, 0], [4, 0], [4, 0],
      ].map(([succeeded, failed], i) => ({ start: `2026-10-${String(5 + i).padStart(2, "0")}T00:00:00.000Z`, succeeded, failed })),
      backups: { succeeded: 131, failed: 2, totalSize: 71 * GiB, drillsPassed: 160, drillsFailed: 1, staleVolumes: 0 },
      cron: { failed: 2, affectedJobs: ["shop-cache-warm"] },
      alerts: {
        fired: 4,
        resolved: 4,
        open: 0,
        top: [
          { label: "Host memory", count: 2 },
          { label: "Killed for memory", count: 1 },
          { label: "Restart loop", count: 1 },
        ],
      },
      resources: [
        { label: "CPU", values: ramp(18, 26, 0.3).slice(-28), latest: 22, peak: 61, unit: "percent" },
        { label: "Memory", values: ramp(64, 79, 0.05).slice(-28), latest: 78, peak: 91, unit: "percent" },
        { label: "Disk", values: ramp(70, 74, 0.005).slice(-28), latest: 74, peak: 74, unit: "percent" },
      ],
      certs: [{ domain: "staging.shop.example.net", daysLeft: 12 }],
      imageUpdates: [
        { appName: "Uptime Kuma", count: 1 },
        { appName: "Search", count: 2 },
      ],
      projects: [
        { name: "Shop", deploys: 19, failures: 2, backupFailures: 1, cronFailures: 2 },
        { name: "Acme Nonprofit", deploys: 22, failures: 1, backupFailures: 0, cronFailures: 0 },
        { name: "Tools", deploys: 7, failures: 0, backupFailures: 0, cronFailures: 0 },
      ],
    },
  },
  {
    name: "digest-daily",
    event: {
      type: "digest.health",
      title: "Daily health summary: Acme Studio",
      message: "6 deploys.",
      cadence: "daily",
      orgName: "Acme Studio",
      windowLabel: "Oct 8, 2026",
      since: "2026-10-08T00:00:00.000Z",
      until: "2026-10-09T00:00:00.000Z",
      deploys: { total: 6, succeeded: 6, failed: 0 },
      deploysByBucket: Array.from({ length: 24 }, (_, h) => ({
        start: `2026-10-08T${String(h).padStart(2, "0")}:00:00.000Z`,
        succeeded: [9, 10, 14, 15, 16, 21].includes(h) ? 1 : 0,
        failed: 0,
      })),
      backups: { succeeded: 19, failed: 0, totalSize: 10 * GiB, drillsPassed: 24, drillsFailed: 0, staleVolumes: 0 },
      cron: { failed: 0, affectedJobs: [] },
      alerts: { fired: 0, resolved: 0, open: 0, top: [] },
      certs: [],
      imageUpdates: [],
      projects: [{ name: "Acme Nonprofit", deploys: 6, failures: 0, backupFailures: 0, cronFailures: 0 }],
    },
  },
  {
    name: "system-shutdown",
    event: {
      type: "system.shutdown",
      title: "Vardo shutting down",
      message: "Vardo is shutting down: SIGTERM.",
      reason: "SIGTERM (host shutdown or container stop)",
      version: "0.1.0 (e36c2e3)",
      uptimeSeconds: 1_209_600,
    },
  },
  {
    name: "system-started",
    event: {
      type: "system.started",
      title: "Vardo started",
      message: "Vardo is back after 2 min 29 s.",
      version: "0.1.0 (e36c2e3)",
      downSeconds: 149,
      hostRebooted: true,
      reason: "SIGTERM (host shutdown or container stop)",
    },
  },
  {
    name: "system-recovered-unclean",
    event: {
      type: "system.recovered-unclean",
      title: "Vardo recovered after an unclean stop",
      message: "No clean-shutdown marker.",
      version: "0.1.0 (e36c2e3)",
      downSeconds: 412,
      hostRebooted: true,
      lastHeartbeatAt: "2026-10-09T16:51:30.000Z",
    },
  },
  {
    name: "system-update-started",
    event: {
      type: "system.update-started",
      title: "Vardo updating",
      message: "vardo update started.",
      fromVersion: "e36c2e3",
      branch: "main",
      fromSlot: "blue",
      toSlot: "green",
    },
  },
  {
    name: "system-updated",
    event: {
      type: "system.updated",
      title: "Vardo updated",
      message: "Updated e36c2e3 → 4f1a9b2.",
      fromVersion: "e36c2e3",
      toVersion: "4f1a9b2",
      fromSlot: "blue",
      toSlot: "green",
      durationSeconds: 212,
      downSeconds: 18,
    },
  },
  {
    name: "system-update-failed",
    event: {
      type: "system.update-failed",
      title: "Vardo update failed",
      message: "Health check failed.",
      fromVersion: "e36c2e3",
      toVersion: "4f1a9b2",
      fromSlot: "blue",
      toSlot: "green",
      step: "Health check",
      error: "New frontend did not become healthy within 120s. Rolled back to blue.",
      durationSeconds: 301,
      rolledBack: true,
      logTail: [
        "  [6/8] Swapping frontend",
        "  · Stopping old frontend...",
        "  · Starting new frontend...",
        "  [7/8] Health check",
        "  ! Health check failed — rolling back to blue slot",
        "  ✗ Update aborted: new frontend did not become healthy within 120s. Rolled back to blue slot.",
      ],
    },
  },
  {
    name: "system-containers-missing",
    event: {
      type: "system.containers-missing",
      title: "Containers didn't come back",
      message: "2 containers were running before the restart and aren't now.",
      containers: [
        { name: "search-data-production-green-meilisearch-1", app: "search-data", state: "exited" },
        { name: "shop-staging-production-blue-worker-1", app: "Shop Staging", state: "created" },
      ],
    },
  },
];
