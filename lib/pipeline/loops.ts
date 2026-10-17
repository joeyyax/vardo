// Background loops grouped and named for the Pipeline page.

import type { LoopStatus } from "@/lib/worker/status";

const GROUPS: { label: string; loops: Record<string, string> }[] = [
  {
    label: "Deploys",
    loops: {
      "deploy-claim": "Deploy queue",
      "deploy-claim-web": "Vardo's own deploys",
      "deploy-request": "Deploy requests",
      "deploy-sweep": "Deploy sweep",
      "rollback-watch": "Rollback watch",
      "git-poll": "Git poll",
      "standby-sweep": "Standby sweep",
      "preview-sweep": "Preview sweep",
      "deploy-stream-expiry": "Deploy log expiry",
    },
  },
  {
    label: "Health and uptime",
    loops: {
      uptime: "Uptime checks",
      "container-health": "Container health",
      "status-reconcile": "Status reconcile",
      "traefik-drift": "Traefik drift",
      "system-alerts": "System alerts",
      "trust-checks": "Trust checks",
    },
  },
  {
    label: "Backups and cron",
    loops: {
      "backup-tick": "Backup schedule",
      "backup-run-finish": "Backup finish",
      "backup-requeue": "Backup requeue",
      "restore-drill": "Restore drills",
      "cron-tick": "Cron",
      "cron-daily": "Daily cron",
    },
  },
  {
    label: "Mesh and network",
    loops: {
      "mesh-heartbeat": "Mesh heartbeat",
      "peer-watch": "Peer watch",
      "probe-guard": "Probe guard",
      "probe-guard-blocklist": "Blocklist",
      "abuse-report": "Abuse reports",
      "cert-export": "Cert export",
      "domain-verification": "Domain verification",
      "cloudflare-only-sync": "Cloudflare ranges",
    },
  },
  {
    label: "Metrics and alerts",
    loops: {
      "metrics-collector": "Metrics collector",
      "metrics-rollup": "Metrics rollup",
      "metrics-orphan-sweep": "Orphan series",
      "cadvisor-retire": "cAdvisor retire",
      "error-rate": "Error rate",
      "notification-retry": "Notification retry",
      "resolved-flush": "Resolved alerts",
      digest: "Digest",
      "app-recaps": "App recaps",
    },
  },
  {
    label: "Housekeeping",
    loops: {
      "worker-watch": "Worker watch",
      "worker-handoff": "Worker handoff",
      "lifecycle-heartbeat": "Lifecycle heartbeat",
      "config-sync": "Config sync",
      "self-update": "Self-update",
      "host-reclaim": "Host reclaim",
      "image-update-sweep": "Image updates",
      "image-update-prune": "Image prune",
      "image-reclaim": "Image reclaim",
      "image-eol-sync": "EOL sync",
      "build-registry-cleanup": "Registry cleanup",
      "integration-check": "Integration check",
    },
  },
];

export type PipelineLoop = {
  name: string;
  label: string;
  intervalMs: number | null;
  lastTickAt: number | null;
  lastOkAt: number | null;
  /** The last pass threw. */
  failed: boolean;
  lastError: string | null;
  enabled: boolean;
  stale: boolean;
};

export type LoopGroup = { label: string; loops: PipelineLoop[] };

const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);

/** Every registered loop in its group, in the order listed; a loop no group names goes under Other. */
export function groupLoops(loops: LoopStatus[]): LoopGroup[] {
  const byName = new Map(loops.map((l) => [l.name, l]));
  const placed = new Set<string>();
  const toLoop = (status: LoopStatus, label: string): PipelineLoop => ({
    name: status.name,
    label,
    intervalMs: status.intervalMs,
    lastTickAt: ms(status.lastTickAt),
    lastOkAt: ms(status.lastOkAt),
    failed: status.state === "failing",
    lastError: status.lastError,
    enabled: status.enabled,
    stale: status.stale,
  });
  const groups: LoopGroup[] = GROUPS.map((group) => ({
    label: group.label,
    loops: Object.entries(group.loops).flatMap(([name, label]) => {
      const status = byName.get(name);
      if (!status) return [];
      placed.add(name);
      return [toLoop(status, label)];
    }),
  }));
  const other = loops.filter((l) => !placed.has(l.name)).map((l) => toLoop(l, l.name));
  if (other.length > 0) groups.push({ label: "Other", loops: other });
  return groups.filter((g) => g.loops.length > 0);
}
