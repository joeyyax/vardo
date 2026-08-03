// ---------------------------------------------------------------------------
// App state facts
//
// The status reconciler writes "missing"/"error" straight to the app row and
// emits nothing, so a container that died outside Vardo leaves no event to
// replay. These facts are reconstructed from the current row plus the window's
// deploys: a state change with a deploy behind it is explained, one without is
// the interesting case.
// ---------------------------------------------------------------------------

import type { AwayFact } from "./types";

/** A deploy that started within this long before a container start explains it. */
export const DEPLOY_EXPLAINS_MS = 30 * 60_000;

export type AwayAppRow = {
  id: string;
  name: string;
  displayName: string;
  status: string;
  parked: boolean;
  containerStartedAt: Date | null;
  updatedAt: Date;
};

export type AwayDeployRow = {
  appId: string;
  status: string;
  startedAt: Date;
};

const DOWN_STATUSES = new Set(["error", "missing"]);

/**
 * Facts for apps whose runtime state moved during the window.
 *
 * Deploys are the only sanctioned cause of a state change, so each app is
 * matched against its deploys in the window before anything is called
 * unexplained.
 */
export function deriveAppStateFacts(
  apps: AwayAppRow[],
  deploys: AwayDeployRow[],
  since: Date,
): AwayFact[] {
  const byApp = new Map<string, AwayDeployRow[]>();
  for (const deploy of deploys) {
    const list = byApp.get(deploy.appId);
    if (list) list.push(deploy);
    else byApp.set(deploy.appId, [deploy]);
  }

  const facts: AwayFact[] = [];

  for (const app of apps) {
    // A deploy in flight owns the status; judging it now would be premature.
    if (app.status === "deploying") continue;

    const appDeploys = byApp.get(app.id) ?? [];
    const latest = appDeploys.reduce<AwayDeployRow | null>(
      (acc, d) => (!acc || d.startedAt > acc.startedAt ? d : acc),
      null,
    );

    const base = {
      family: "app" as const,
      subjectId: app.id,
      subjectName: app.displayName,
      href: `/apps/${app.name}`,
    };

    const down = DOWN_STATUSES.has(app.status);
    const stopped = app.status === "stopped";

    // A parked app being off is the declaration working, not a fact. Its
    // restart branch below still fires — coming back up is the surprising part.
    if ((down || stopped) && !app.parked && app.updatedAt >= since) {
      // A failed deploy already reports itself — don't say it twice.
      if (latest?.status === "failed") continue;

      if (latest?.status === "success") {
        // A stopped slot after a good deploy is blue-green settling.
        if (!down) continue;
        facts.push({
          ...base,
          kind: "app.broke-after-deploy",
          at: app.updatedAt,
          outcome: "failure",
          detail: `Deploy succeeded, app is now ${app.status}`,
        });
        continue;
      }

      // Cancelled or rolled-back deploys account for the state well enough.
      if (latest) continue;

      facts.push({
        ...base,
        kind: down ? "app.down-unexplained" : "app.stopped-unexplained",
        at: app.updatedAt,
        outcome: "failure",
        detail: `Now ${app.status}, no deploy to explain it`,
      });
      continue;
    }

    // Container came back up on its own — restart policy, host reboot or a
    // crash loop that settled. None of those are visible anywhere else.
    if (app.containerStartedAt && app.containerStartedAt >= since) {
      const explained = appDeploys.some(
        (d) =>
          d.startedAt <= app.containerStartedAt! &&
          app.containerStartedAt!.getTime() - d.startedAt.getTime() <=
            DEPLOY_EXPLAINS_MS,
      );
      facts.push({
        ...base,
        kind: explained ? "app.restart-expected" : "app.restarted-unexplained",
        at: app.containerStartedAt,
        outcome: "neutral",
        detail: explained ? undefined : "Container restarted without a deploy",
      });
    }
  }

  return facts;
}
