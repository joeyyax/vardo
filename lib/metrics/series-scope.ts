// ---------------------------------------------------------------------------
// Which stored time series belong to one app.
//
// Every container in a decomposed stack carries the parent's vardo labels, so
// its series are stored under the parent's project name. A child reads under
// the parent and narrows by compose service — the same shape as
// appContainerScope, one layer down.
// ---------------------------------------------------------------------------

/** An app row as far as time-series lookup is concerned. */
export type SeriesOwnerApp = {
  name: string;
  parentAppId?: string | null;
  composeService?: string | null;
  parentApp?: { name: string } | null;
};

export type SeriesScope = {
  /** `project` label the series carry. */
  project: string;
  /** `service` label narrowing a stack child to its own containers. */
  service: string | null;
};

/** Labels an app's stored metrics live under. */
export function appSeriesScope(app: SeriesOwnerApp): SeriesScope {
  if (!app.parentAppId) return { project: app.name, service: null };
  return {
    project: app.parentApp?.name ?? app.name,
    service: app.composeService ?? null,
  };
}
