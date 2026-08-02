/**
 * App counting for metrics surfaces. Every count on screen is one of these, and
 * the tile subtitle says which: `/projects` lists top-level apps for one org,
 * `/metrics` covers one org, `/admin` covers the whole instance — and compose
 * children are app records too, so a raw row count is always the largest number.
 */

export type ScopeApp = {
  status: string;
  parentAppId?: string | null;
};

export type AppStatusCounts = {
  active: number;
  stopped: number;
  error: number;
  deploying: number;
  missing: number;
};

export type ScopeCounts = {
  /** App records in scope, top-level and compose children together. */
  total: number;
  /** Apps with no parent — what `/projects` lists. */
  topLevel: number;
  /** Services broken out of a parent's compose file. */
  composeServices: number;
  byStatus: AppStatusCounts;
};

const EMPTY_STATUS: AppStatusCounts = {
  active: 0,
  stopped: 0,
  error: 0,
  deploying: 0,
  missing: 0,
};

export function countApps(apps: ScopeApp[]): ScopeCounts {
  const byStatus = { ...EMPTY_STATUS };
  let composeServices = 0;

  for (const app of apps) {
    if (app.parentAppId) composeServices++;
    if (app.status in byStatus) byStatus[app.status as keyof AppStatusCounts]++;
  }

  return {
    total: apps.length,
    topLevel: apps.length - composeServices,
    composeServices,
    byStatus,
  };
}

/** "59 apps · 51 compose services" — the sentence that makes a total checkable. */
export function describeScopeCounts(counts: ScopeCounts): string {
  const apps = `${counts.topLevel} app${counts.topLevel === 1 ? "" : "s"}`;
  if (counts.composeServices === 0) return apps;
  return `${apps} · ${counts.composeServices} compose service${counts.composeServices === 1 ? "" : "s"}`;
}
