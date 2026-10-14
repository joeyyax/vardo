import type { AttentionRow } from "@/lib/ui/attention";
import { deployHref } from "@/lib/ui/hrefs";

export type ActiveDeployment = { id: string; appId: string; gitSha: string | null; startedAt: Date; status?: string };
export type ActiveBackup = { id: string; appId: string; startedAt: Date };

export type FleetActivity = {
  deployments: ActiveDeployment[];
  backups: ActiveBackup[];
};

type ActivitySubject = { id: string; name: string; displayName: string };

/** Most recent row per app, so an app with several queued backups is one row. */
function latestPerApp<T extends { appId: string }>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    if (!latest.has(row.appId)) latest.set(row.appId, row);
  }
  return [...latest.values()];
}

/** Deploys and backups in progress, one row per kind, in the routine "activity" tone. */
export function activityRows(apps: ActivitySubject[], activity: FleetActivity): AttentionRow[] {
  const byId = new Map(apps.map((a) => [a.id, a]));
  const rows: AttentionRow[] = [];

  const deployItems = (list: ActiveDeployment[]) =>
    list.flatMap((d) => {
      const app = byId.get(d.appId);
      if (!app) return [];
      return [
        {
          id: d.id,
          name: app.displayName,
          href: deployHref(app.name, d.id),
          detail: d.gitSha ? d.gitSha.slice(0, 7) : undefined,
          since: d.startedAt.toISOString(),
        },
      ];
    });

  // An app with a deploy running shows as deploying, even with more queued behind it.
  const deploying = latestPerApp(activity.deployments.filter((d) => d.status !== "queued"));
  const busy = new Set(deploying.map((d) => d.appId));
  const queued = latestPerApp(activity.deployments.filter((d) => d.status === "queued" && !busy.has(d.appId)));
  if (deploying.length > 0) {
    rows.push({
      key: "deploying",
      label: "Deploying",
      tone: "activity",
      items: deployItems(deploying),
      footer: "Clears on its own once the deploy finishes.",
    });
  }
  if (queued.length > 0) {
    rows.push({
      key: "deploy-queued",
      label: "Queued",
      tone: "activity",
      items: deployItems(queued),
      footer: "Starts on its own once an executor picks it up.",
    });
  }

  const backingUp = latestPerApp(activity.backups);
  if (backingUp.length > 0) {
    rows.push({
      key: "backup-running",
      label: "Backup running",
      tone: "activity",
      items: backingUp.flatMap((b) => {
        const app = byId.get(b.appId);
        if (!app) return [];
        return [
          {
            id: b.id,
            name: app.displayName,
            href: `/apps/${app.name}/backups`,
            since: b.startedAt.toISOString(),
          },
        ];
      }),
      footer: "Clears on its own once the backup finishes.",
    });
  }

  return rows.filter((r) => r.items.length > 0);
}
