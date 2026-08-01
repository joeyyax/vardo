import type { AwayFamily, AwayReason } from "./types";

const KIND_LABELS: Record<string, string> = {
  "deploy.failed": "Deploy failed",
  "deploy.rollback": "Rolled back",
  "backup.failed": "Backup failed",
  "cron.failed": "Cron job failed",
  "domain.unreachable": "Domain unreachable",
  "security.scan-findings": "Security findings",
  "security.file-exposed": "File exposed",
  "app.down-unexplained": "App is down",
  "app.stopped-unexplained": "App stopped",
  "app.broke-after-deploy": "Broke after deploy",
  "app.restarted-unexplained": "Restarted on its own",
  "app.gave-up-restarting": "Gave up restarting",
  "volume.drift": "Volume drift",
  "disk.write-alert": "Heavy disk writes",
  "system.cert-expiring": "Certificate expiring",
  "system.disk-alert": "Disk space",
  "system.service-down": "Service down",
  "system.restart-loop": "Restart loop",
  "system.host-restarted": "Host restarted",
};

/** Human phrase for a kind, falling back to a readable form of the raw string. */
export function kindLabel(kind: string): string {
  const known = KIND_LABELS[kind];
  if (known) return known;
  const words = kind.replace(/[._-]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Why the item is on the list. Rendered, not just scored on. */
export const REASON_LABELS: Record<AwayReason, string> = {
  "first-failure": "First failure",
  regression: "Normally succeeds",
  recurring: "Fails regularly",
  unexplained: "Nothing explains it",
  alert: "Alert",
  change: "Changed by someone else",
  unrecognized: "Unclassified",
};

/** Status hue per reason. Color is the only saturated thing on this surface. */
export const REASON_TONE: Record<AwayReason, "error" | "warning" | "neutral"> = {
  "first-failure": "error",
  unexplained: "error",
  alert: "error",
  regression: "warning",
  recurring: "warning",
  unrecognized: "warning",
  change: "neutral",
};

const FAMILY_NOUNS: Record<AwayFamily, [string, string]> = {
  deploy: ["deploy", "deploys"],
  backup: ["backup", "backups"],
  cron: ["cron run", "cron runs"],
  app: ["restart", "restarts"],
  domain: ["domain check", "domain checks"],
  security: ["scan", "scans"],
  system: ["notice", "notices"],
  org: ["org change", "org changes"],
};

export function familyLabel(family: AwayFamily, count: number): string {
  const [one, many] = FAMILY_NOUNS[family];
  return `${count} ${count === 1 ? one : many}`;
}
