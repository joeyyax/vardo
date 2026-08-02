// ---------------------------------------------------------------------------
// What a batch apply actually did, per app.
//
// Dispatching six updates and reporting "6 updated" is the failure this
// prevents: a rate limit or a stale check fails individual rows while the rest
// land, and the caller has to be told which.
// ---------------------------------------------------------------------------

export interface BatchItemResult {
  appId: string;
  appName: string | null;
  displayName: string | null;
  service: string | null;
  tag: string;
  ok: boolean;
  error?: string;
}

export interface AppOutcome {
  appId: string;
  appName: string | null;
  displayName: string;
  applied: number;
  failed: BatchItemResult[];
}

export interface BatchReport {
  applied: number;
  failed: number;
  total: number;
  /** One entry per app touched, apps with failures first. */
  apps: AppOutcome[];
  /** Sentence for the toast — never claims more than landed. */
  message: string;
}

/** Stable identity for a row across select, apply and result. */
export function rowKey(appId: string, service: string | null): string {
  return `${appId}:${service ?? ""}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function summarizeBatch(results: BatchItemResult[]): BatchReport {
  const byApp = new Map<string, AppOutcome>();

  for (const result of results) {
    const outcome = byApp.get(result.appId) ?? {
      appId: result.appId,
      appName: result.appName,
      displayName: result.displayName ?? result.appName ?? result.appId,
      applied: 0,
      failed: [],
    };
    if (result.ok) outcome.applied++;
    else outcome.failed.push(result);
    byApp.set(result.appId, outcome);
  }

  const apps = [...byApp.values()].sort(
    (a, b) => b.failed.length - a.failed.length || a.displayName.localeCompare(b.displayName),
  );
  const applied = results.filter((r) => r.ok).length;
  const failed = results.length - applied;

  return {
    applied,
    failed,
    total: results.length,
    apps,
    message: batchMessage(applied, failed, apps),
  };
}

function batchMessage(applied: number, failed: number, apps: AppOutcome[]): string {
  const appsWithFailures = apps.filter((a) => a.failed.length > 0);

  if (failed === 0) {
    return `Pinned ${plural(applied, "image", "images")} across ${plural(apps.length, "app", "apps")}. Deploy to apply.`;
  }
  if (applied === 0) {
    return failed === 1 && appsWithFailures[0]?.failed[0]?.error
      ? appsWithFailures[0].failed[0].error
      : `None of the ${plural(failed, "update", "updates")} could be applied.`;
  }
  return `Pinned ${applied} of ${applied + failed}. ${plural(failed, "update", "updates")} failed on ${appsWithFailures
    .map((a) => a.displayName)
    .join(", ")}.`;
}
