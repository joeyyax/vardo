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
  start?: (role: LoopRole) => Promise<void>;
  /** Stops a loop started through `start`. */
  stop?: () => Promise<void>;
  /** Serves only this process, so web keeps it while a worker runs the rest. */
  perProcess?: boolean;
  /** A stale heartbeat fails the worker's health check. */
  critical?: boolean;
};

const BOTH: LoopRole[] = ["web", "worker"];
// Loops that serve this process's own memory or files, plus deploy triggers that run in web.
const WEB: LoopRole[] = ["web"];
const WORKER: LoopRole[] = ["worker"];

export const LOOP_REGISTRY: LoopEntry[] = [
  // Per process: feature flags and resource settings follow writes from any process.
  { name: "config-sync", roles: BOTH, singleton: false, perProcess: true, load: async () => (await import("@/lib/config/sync")).configSyncLoop },

  // Deploys. The worker claims app deploys, web Vardo's own (lib/deploy/claim-scope.ts).
  { name: "deploy-claim", roles: WORKER, singleton: false, critical: true, load: async () => (await import("@/lib/deploy/claim-loop")).deployClaimLoop },
  { name: "deploy-claim-web", roles: WEB, singleton: false, load: async () => (await import("@/lib/deploy/claim-loop")).webDeployClaimLoop },
  { name: "deploy-sweep", roles: BOTH, singleton: true, critical: true, load: async () => (await import("@/lib/deploy/scheduler")).deploySweepLoop },
  { name: "rollback-watch", roles: BOTH, singleton: true, load: async () => (await import("@/lib/deploy/scheduler")).rollbackWatchLoop },
  { name: "standby-sweep", roles: BOTH, singleton: true, load: async () => (await import("@/lib/deploy/scheduler")).standbySweepLoop },
  { name: "deploy-stream-expiry", roles: BOTH, singleton: true, load: async () => (await import("@/lib/deploy/scheduler")).deployStreamExpiryLoop },
  { name: "preview-sweep", roles: BOTH, singleton: true, feature: "previews", load: async () => (await import("@/lib/docker/preview-sweeper")).previewSweepLoop },
  { name: "git-poll", roles: WEB, singleton: true, load: async () => (await import("@/lib/git-integration/poll-scheduler")).gitPollLoop },
  { name: "deploy-request", roles: WEB, singleton: false, load: async () => (await import("@/lib/lifecycle/deploy-request")).deployRequestLoop },
  { name: "self-update", roles: WEB, singleton: true, load: async () => (await import("@/lib/self-update/runner")).selfUpdateLoop },

  // Backups
  { name: "backup-tick", roles: BOTH, singleton: true, critical: true, after: "backup-target", load: async () => (await import("@/lib/backups/scheduler")).backupTickLoop },
  { name: "backup-run-finish", roles: BOTH, singleton: true, after: "backup-target", load: async () => (await import("@/lib/backups/scheduler")).backupRunFinishLoop },
  { name: "restore-drill", roles: BOTH, singleton: true, after: "backup-target", load: async () => (await import("@/lib/backups/scheduler")).restoreDrillLoop },
  { name: "backup-requeue", roles: BOTH, singleton: true, after: "backup-target", load: async () => (await import("@/lib/backups/scheduler")).backupRequeueLoop },

  // Containers and routing
  { name: "container-health", roles: BOTH, singleton: true, critical: true, feature: "monitoring", load: async () => (await import("@/lib/docker/health-monitor")).containerHealthLoop },
  { name: "status-reconcile", roles: BOTH, singleton: true, feature: "monitoring", load: async () => (await import("@/lib/docker/status-reconcile")).statusReconcileLoop },
  { name: "traefik-drift", roles: BOTH, singleton: true, feature: "monitoring", load: async () => (await import("@/lib/docker/traefik-drift")).traefikDriftLoop },
  { name: "system-alerts", roles: BOTH, singleton: true, feature: "monitoring", load: async () => (await import("@/lib/system-alerts/monitor")).systemAlertsLoop },
  { name: "probe-guard", roles: BOTH, singleton: true, load: async () => (await import("@/lib/probe-guard/loop")).probeGuardLoop },
  { name: "probe-guard-blocklist", roles: BOTH, singleton: true, load: async () => (await import("@/lib/probe-guard/blocklist/loop")).blocklistLoop },
  { name: "abuse-report", roles: BOTH, singleton: true, load: async () => (await import("@/lib/probe-guard/reporting/loop")).abuseReportLoop },
  { name: "cloudflare-only-sync", roles: BOTH, singleton: true, load: async () => (await import("@/lib/docker/cloudflare-only")).cloudflareOnlyLoop },
  { name: "trust-checks", roles: BOTH, singleton: true, load: async () => (await import("@/lib/trust/loop")).trustLoop },
  { name: "cert-export", roles: BOTH, singleton: true, load: async () => (await import("@/lib/ssl/cert-export")).certExportLoop },
  { name: "image-update-sweep", roles: BOTH, singleton: true, feature: "image-updates", load: async () => (await import("@/lib/docker/image-updates/scheduler")).imageUpdateSweepLoop },
  { name: "image-update-prune", roles: BOTH, singleton: true, feature: "image-updates", load: async () => (await import("@/lib/docker/image-updates/scheduler")).imageUpdatePruneLoop },
  { name: "image-eol-sync", roles: WEB, singleton: false, feature: "image-updates", load: async () => (await import("@/lib/docker/image-updates/eol-sync")).eolSyncLoop },
  { name: "host-reclaim", roles: BOTH, singleton: true, load: async () => (await import("@/lib/docker/host-reclaim/scheduler")).hostReclaimLoop },
  { name: "image-reclaim", roles: BOTH, singleton: true, feature: "image-updates", load: async () => (await import("@/lib/docker/image-reclaim/scheduler")).imageReclaimLoop },

  // Scheduled work
  { name: "cron-tick", roles: BOTH, singleton: true, critical: true, feature: "cron", load: async () => (await import("@/lib/cron/scheduler")).cronTickLoop },
  { name: "cron-daily", roles: BOTH, singleton: true, feature: "cron", load: async () => (await import("@/lib/cron/scheduler")).cronDailyLoop },
  { name: "digest", roles: BOTH, singleton: true, feature: "digest", load: async () => (await import("@/lib/digest/scheduler")).digestLoop },
  { name: "app-recaps", roles: BOTH, singleton: true, feature: "notifications", load: async () => (await import("@/lib/recaps/scheduler")).recapLoop },
  { name: "notification-retry", roles: BOTH, singleton: true, feature: "notifications", load: async () => (await import("@/lib/notifications/scheduler")).notificationRetryLoop },
  // Not gated on notifications, so held resolutions never pile up.
  { name: "resolved-flush", roles: BOTH, singleton: true, load: async () => (await import("@/lib/notifications/scheduler")).resolvedFlushLoop },
  { name: "integration-check", roles: BOTH, singleton: true, load: async () => (await import("@/lib/integrations/check")).integrationCheckLoop },

  // Observability
  {
    name: "metrics-collector",
    // Per process: alert passes read the snapshot it keeps. Web hands it over with the loops that read it.
    roles: BOTH,
    singleton: false,
    feature: "metrics",
    load: async () => (await import("@/lib/metrics/collector")).collectorLoop,
    start: async (role) => (await import("@/lib/metrics/collector")).startCollector(role),
    stop: async () => (await import("@/lib/metrics/collector")).stopCollector(),
  },
  // Not gated on metrics: with it off, cAdvisor goes without the guard.
  { name: "cadvisor-retire", roles: BOTH, singleton: true, load: async () => (await import("@/lib/infra/retire-cadvisor")).retireCadvisorLoop },
  { name: "metrics-orphan-sweep", roles: BOTH, singleton: true, feature: "metrics", load: async () => (await import("@/lib/metrics/series-cleanup")).orphanSeriesLoop },
  // Not gated on metrics: domain checks roll up without it.
  { name: "metrics-rollup", roles: BOTH, singleton: true, load: async () => (await import("@/lib/metrics/rollup")).metricsRollupLoop },
  { name: "error-rate", roles: BOTH, singleton: true, feature: "logging", load: async () => (await import("@/lib/logging/register")).errorRateLoop },
  { name: "domain-monitoring", roles: BOTH, singleton: true, feature: "domain-monitoring", load: async () => (await import("@/lib/domain-monitoring/scheduler")).domainMonitoringLoop },
  { name: "domain-verification", roles: BOTH, singleton: true, load: async () => (await import("@/lib/domains/scheduler")).domainVerificationLoop },
  // Repairs the tunnel forward to this console and reports this console's version.
  { name: "mesh-heartbeat", roles: WEB, singleton: true, load: async () => (await import("@/lib/mesh/scheduler")).meshHeartbeatLoop },
  { name: "peer-watch", roles: BOTH, singleton: true, feature: "mesh", load: async () => (await import("@/lib/mesh/peer-watch")).peerWatchLoop },

  // Worker supervision, from web
  { name: "worker-handoff", roles: WEB, singleton: false, perProcess: true, load: async () => (await import("@/lib/worker/handoff")).workerHandoffLoop },
  { name: "worker-watch", roles: WEB, singleton: true, load: async () => (await import("@/lib/worker/watch")).workerWatchLoop },
  {
    name: "lifecycle-heartbeat",
    roles: WEB,
    singleton: false,
    load: async () => (await import("@/lib/lifecycle/monitor")).lifecycleHeartbeatLoop,
    start: async () => (await import("@/lib/lifecycle/monitor")).startLifecycleMonitor(),
  },
];

export const LOOP_NAMES = LOOP_REGISTRY.map((entry) => entry.name);
