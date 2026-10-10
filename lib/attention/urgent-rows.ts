// Failed deploys and open anomaly alerts as attention rows. Pure; the reads live in ./rows.

import type { AttentionItem, AttentionRow } from "@/lib/ui/attention";
import { appHref, deployHref } from "@/lib/ui/hrefs";
import { deployFailureUrgent, isQuiet } from "@/lib/ui/urgency";

/** A failed deploy older than this is history, not something to act on. */
export const DEPLOY_FAILURE_WINDOW_HOURS = 48;

type Subject = { id: string; name: string; displayName: string; status: string; parked: boolean };

export type LatestDeploy = {
  id: string;
  appId: string;
  status: string;
  gitSha: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

/** Apps whose latest deploy failed. Urgent within the hour, routine after. */
export function deployFailureRows(apps: Subject[], latest: LatestDeploy[], now: number): AttentionRow[] {
  const byId = new Map(apps.map((a) => [a.id, a]));
  const items: AttentionItem[] = [];
  for (const d of latest) {
    const app = byId.get(d.appId);
    if (!app || d.status !== "failed" || isQuiet(app)) continue;
    const urgent = deployFailureUrgent(d, app, now);
    items.push({
      id: d.id,
      subject: app.id,
      name: app.displayName,
      title: "Deploy failed",
      tone: urgent ? "error" : "warning",
      href: deployHref(app.name, d.id),
      detail: d.gitSha ? d.gitSha.slice(0, 7) : undefined,
      since: (d.finishedAt ?? d.startedAt).toISOString(),
      fix: { label: "Retry deploy", run: "deploy", app: { id: app.id, name: app.name } },
      urgent,
    });
  }
  if (items.length === 0) return [];
  return [
    {
      key: "deploy-failed",
      label: "Deploy failed",
      tone: items.some((i) => i.urgent) ? "error" : "warning",
      group: "failed",
      items,
      footer: "The latest deploy for each of these failed. Whatever ran before is still serving, if anything was.",
    },
  ];
}

export type OpenAnomaly = { about: string; appId: string | null; title: string; sentAt: Date };

/** Anomaly alerts that haven't cleared. Every one is urgent. */
export function anomalyRows(apps: Subject[], open: OpenAnomaly[]): AttentionRow[] {
  const byId = new Map(apps.map((a) => [a.id, a]));
  const items: AttentionItem[] = [];
  for (const alert of open) {
    const app = alert.appId ? byId.get(alert.appId) : undefined;
    if (!app || isQuiet(app)) continue;
    items.push({
      id: `anomaly:${alert.about}:${alert.title}`,
      subject: app.id,
      name: app.displayName,
      title: "Unusual activity",
      href: appHref(app.name, "metrics"),
      detail: alert.title,
      since: alert.sentAt.toISOString(),
      urgent: true,
    });
  }
  if (items.length === 0) return [];
  return [
    {
      key: "anomaly",
      label: "Unusual activity",
      tone: "error",
      group: "anomaly",
      items,
      footer: "Far outside the app's own normal. If nothing explains it, a compromised app can look like this.",
    },
  ];
}
