import type { AttentionRow } from "@/lib/ui/attention";

export type ElevatedSubject = { appId: string; recent: number; baseline: number };

type AppSubject = { id: string; name: string; displayName: string };

/**
 * Apps logging errors far faster than they normally do. Warning, not error —
 * the app is up and serving, it is only noisier than it has ever been.
 */
export function errorRateRows(apps: AppSubject[], elevated: ElevatedSubject[]): AttentionRow[] {
  const byId = new Map(apps.map((a) => [a.id, a]));

  const items = elevated.flatMap((e) => {
    const app = byId.get(e.appId);
    if (!app) return [];
    return [
      {
        id: `error-rate-${e.appId}`,
        name: app.displayName,
        href: `/apps/${app.name}/errors`,
        detail: `${e.recent} in 30 min · usually ${e.baseline}`,
      },
    ];
  });

  if (items.length === 0) return [];

  return [
    {
      key: "error-rate",
      label: "Errors up",
      tone: "warning",
      items,
      footer:
        "Matching lines in the last half hour, against every other half hour in the past week. Deploys and restarts are excluded.",
    },
  ];
}
