// Every background loop, and where and how it runs. Stage 2 starts the same list in a worker.

import type { FeatureFlag } from "@/lib/config/features";
import type { IntervalLoop, LoopRole } from "./interval-loop";

export type LoopEntry = {
  name: string;
  roles: LoopRole[];
  /** One process at a time, through a Postgres lease. */
  singleton: boolean;
  /** Started only when this flag is on at boot; passes skip while it's off. */
  feature?: FeatureFlag;
  /** Waits for this boot step before starting. */
  after?: "backup-target";
  load: () => Promise<IntervalLoop>;
  /** Starts the loop through its own boot step instead of `loop.start()`. */
  start?: () => Promise<void>;
};

const BOTH: LoopRole[] = ["web", "worker"];
// Loops that serve this process's own memory or files stay with the web process.
const WEB: LoopRole[] = ["web"];

export const LOOP_REGISTRY: LoopEntry[] = [
  // Per process: feature flags and resource settings follow writes from any process.
  { name: "config-sync", roles: BOTH, singleton: false, load: async () => (await import("@/lib/config/sync")).configSyncLoop },

  // Deploys
  { name: "deploy-sweep", roles: BOTH, singleton: true, load: async () => (await import("@/lib/deploy/scheduler")).deploySweepLoop },
  { name: "rollback-watch", roles: BOTH, singleton: true, load: async () => (await import("@/lib/deploy/scheduler")).rollbackWatchLoop },
  { name: "standby-sweep", roles: BOTH, singleton: true, load: async () => (await import("@/lib/deploy/scheduler")).standbySweepLoop },
  { name: "deploy-stream-expiry", roles: BOTH, singleton: true, load: async () => (await import("@/lib/deploy/scheduler")).deployStreamExpiryLoop },
  { name: "preview-sweep", roles: BOTH, singleton: true, feature: "previews", load: async () => (await import("@/lib/docker/preview-sweeper")).previewSweepLoop },
  { name: "git-poll", roles: BOTH, singleton: true, load: async () => (await import("@/lib/git-integration/poll-scheduler")).gitPollLoop },
  { name: "deploy-request", roles: WEB, singleton: false, load: async () => (await import("@/lib/lifecycle/deploy-request")).deployRequestLoop },
  { name: "self-update", roles: BOTH, singleton: true, load: async () => (await import("@/lib/self-update/runner")).selfUpdateLoop },

  // Backups
  { name: "backup-tick", roles: BOTH, singleton: true, after: "backup-target", load: async () => (await import("@/lib/backups/scheduler")).backupTickLoop },
  { name: "backup-run-finish", roles: BOTH, singleton: true, after: "backup-target", load: async () => (await import("@/lib/backups/scheduler")).backupRunFinishLoop },
  { name: "restore-drill", roles: BOTH, singleton: true, after: "backup-target", load: async () => (await import("@/lib/backups/scheduler")).restoreDrillLoop },
  { name: "backup-requeue", roles: BOTH, singleton: true, after: "backup-target", load: async () => (await import("@/lib/backups/scheduler")).backupRequeueLoop },

  // Containers and routing
  { name: "container-health", roles: BOTH, singleton: true, feature: "monitoring", load: async () => (await import("@/lib/docker/health-monitor")).containerHealthLoop },
  { name: "status-reconcile", roles: BOTH, singleton: true, feature: "monitoring", load: async () => (await import("@/lib/docker/status-reconcile")).statusReconcileLoop },
  { name: "traefik-drift", roles: BOTH, singleton: true, feature: "monitoring", load: async () => (await import("@/lib/docker/traefik-drift")).traefikDriftLoop },
  { name: "system-alerts", roles: BOTH, singleton: true, feature: "monitoring", load: async () => (await import("@/lib/system-alerts/monitor")).systemAlertsLoop },
  { name: "cloudflare-only-sync", roles: BOTH, singleton: true, load: async () => (await import("@/lib/docker/cloudflare-only")).cloudflareOnlyLoop },
  { name: "cert-export", roles: BOTH, singleton: true, load: async () => (await import("@/lib/ssl/cert-export")).certExportLoop },
  { name: "image-update-sweep", roles: BOTH, singleton: true, feature: "image-updates", load: async () => (await import("@/lib/docker/image-updates/scheduler")).imageUpdateSweepLoop },
  { name: "image-update-prune", roles: BOTH, singleton: true, feature: "image-updates", load: async () => (await import("@/lib/docker/image-updates/scheduler")).imageUpdatePruneLoop },
  { name: "image-eol-sync", roles: WEB, singleton: false, feature: "image-updates", load: async () => (await import("@/lib/docker/image-updates/eol-sync")).eolSyncLoop },
  { name: "image-reclaim", roles: BOTH, singleton: true, feature: "image-updates", load: async () => (await import("@/lib/docker/image-reclaim/scheduler")).imageReclaimLoop },

  // Scheduled work
  { name: "cron-tick", roles: BOTH, singleton: true, feature: "cron", load: async () => (await import("@/lib/cron/scheduler")).cronTickLoop },
  { name: "cron-daily", roles: BOTH, singleton: true, feature: "cron", load: async () => (await import("@/lib/cron/scheduler")).cronDailyLoop },
  { name: "digest", roles: BOTH, singleton: true, feature: "digest", load: async () => (await import("@/lib/digest/scheduler")).digestLoop },
  { name: "notification-retry", roles: BOTH, singleton: true, feature: "notifications", load: async () => (await import("@/lib/notifications/scheduler")).notificationRetryLoop },
  { name: "integration-check", roles: BOTH, singleton: true, load: async () => (await import("@/lib/integrations/check")).integrationCheckLoop },

  // Observability
  {
    name: "metrics-collector",
    roles: WEB,
    singleton: false,
    feature: "metrics",
    load: async () => (await import("@/lib/metrics/collector")).collectorLoop,
    start: async () => (await import("@/lib/metrics/collector")).startCollector(),
  },
  { name: "metrics-orphan-sweep", roles: BOTH, singleton: true, feature: "metrics", load: async () => (await import("@/lib/metrics/series-cleanup")).orphanSeriesLoop },
  { name: "error-rate", roles: BOTH, singleton: true, feature: "logging", load: async () => (await import("@/lib/logging/register")).errorRateLoop },
  { name: "domain-monitoring", roles: BOTH, singleton: true, feature: "domain-monitoring", load: async () => (await import("@/lib/domain-monitoring/scheduler")).domainMonitoringLoop },
  { name: "domain-verification", roles: BOTH, singleton: true, load: async () => (await import("@/lib/domains/scheduler")).domainVerificationLoop },
  { name: "mesh-heartbeat", roles: BOTH, singleton: true, load: async () => (await import("@/lib/mesh/scheduler")).meshHeartbeatLoop },
  {
    name: "lifecycle-heartbeat",
    roles: WEB,
    singleton: false,
    load: async () => (await import("@/lib/lifecycle/monitor")).lifecycleHeartbeatLoop,
    start: async () => (await import("@/lib/lifecycle/monitor")).startLifecycleMonitor(),
  },
];

export const LOOP_NAMES = LOOP_REGISTRY.map((entry) => entry.name);
