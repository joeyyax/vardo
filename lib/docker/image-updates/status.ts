import { refCacheKey } from "./image-ref";
import { appImages, type UpdatableApp } from "./compose-images";
import { readCachedChecks, CHECK_TTL_MS } from "./check";
import { indexRules, silencedBy, type IgnoreRule } from "./ignore";
import { readIgnoreRules } from "./read-ignores";
import { readMajorGateBlock } from "./major-gate-store";
import type { MajorGateBlock } from "./major-gate";
import type { BumpSeverity } from "./tag-version";
import type { CheckStatus } from "./check";

/**
 * Read-only view over the cache. Page loads call this and never touch a
 * registry, so rendering an app costs nothing against the pull budget.
 */

export interface ServiceUpdateStatus {
  service: string | null;
  image: string;
  currentTag: string;
  status: CheckStatus;
  latestTag: string | null;
  severity: BumpSeverity | null;
  unorderable: string[];
  /** Newer tags to choose from, newest first. */
  available: string[];
  /** Newest tag crossing a major, offered separately from `latestTag`. */
  majorAvailable: string | null;
  /** Whether a major bump means migrating a data directory. */
  majorLocked: boolean;
  error: string | null;
  checkedAt: string | null;
  /** True when the cached answer is past its TTL. */
  stale: boolean;
}

/** An update an ignore rule is currently hiding. */
export interface IgnoredUpdate {
  service: ServiceUpdateStatus;
  rule: IgnoreRule;
}

export interface AppUpdateStatus {
  services: ServiceUpdateStatus[];
  /** Services with a newer tag or a drifted floating tag. */
  updateCount: number;
  /** Highest severity among available updates, for UI emphasis. */
  highestSeverity: BumpSeverity | null;
  /** True when at least one service could not be answered. */
  hasUnknown: boolean;
  /** Actionable updates withheld by an ignore rule. */
  ignored: IgnoredUpdate[];
  /** A deploy the major gate stopped, still waiting on a decision. */
  blockedMigration: MajorGateBlock | null;
}

const SEVERITY_RANK: Record<BumpSeverity, number> = {
  build: 1,
  patch: 2,
  minor: 3,
  major: 4,
  unknown: 0,
};

type CachedChecks = Awaited<ReturnType<typeof readCachedChecks>>;

function buildServices(
  app: UpdatableApp,
  cached: CachedChecks,
  cutoff: number,
): ServiceUpdateStatus[] {
  return appImages(app).map((entry) => {
    const row = cached.get(refCacheKey(entry.ref));
    return {
      service: entry.service,
      image: entry.image,
      currentTag: entry.ref.tag,
      status: row?.status ?? "unknown",
      latestTag: row?.latestTag ?? null,
      severity: (row?.severity as BumpSeverity | null) ?? null,
      unorderable: row?.unorderable ?? [],
      available: row?.available ?? [],
      majorAvailable: row?.majorAvailable ?? null,
      majorLocked: row?.majorLocked ?? false,
      error: row?.error ?? (row ? null : "Not checked yet"),
      checkedAt: row?.checkedAt.toISOString() ?? null,
      stale: !row || row.checkedAt.getTime() < cutoff,
    };
  });
}

function isActionable(service: ServiceUpdateStatus): boolean {
  return service.status === "update" || service.status === "drift";
}

/**
 * Splits an app's services into what to show and what a rule is hiding. The
 * ignored ones stay in the answer so they can be listed and undone.
 */
function partition(
  services: ServiceUpdateStatus[],
  appId: string | undefined,
  rules: Map<string, IgnoreRule>,
  now: number,
): { services: ServiceUpdateStatus[]; ignored: IgnoredUpdate[] } {
  if (!appId || rules.size === 0) return { services, ignored: [] };

  const kept: ServiceUpdateStatus[] = [];
  const ignored: IgnoredUpdate[] = [];
  for (const service of services) {
    const rule = isActionable(service)
      ? silencedBy(rules, { appId, service: service.service, severity: service.severity }, now)
      : null;
    if (rule) ignored.push({ service, rule });
    else kept.push(service);
  }
  return { services: kept, ignored };
}

function rollUp(
  services: ServiceUpdateStatus[],
): Omit<AppUpdateStatus, "services" | "ignored" | "blockedMigration"> {
  let highest: BumpSeverity | null = null;
  let updateCount = 0;
  let hasUnknown = false;

  for (const service of services) {
    if (service.status === "unknown") hasUnknown = true;
    if (!isActionable(service)) continue;
    updateCount++;
    const severity = service.severity ?? "unknown";
    if (!highest || SEVERITY_RANK[severity] > SEVERITY_RANK[highest]) highest = severity;
  }

  return { updateCount, highestSeverity: highest, hasUnknown };
}

/**
 * The gate's block, narrowed to what this app owns. A child service reads the
 * parent's block — the deploy that was stopped ran against the parent.
 */
async function blockFor(app: UpdatableApp & { id?: string; composeOwnerId?: string }) {
  const owner = app.composeOwnerId ?? app.id;
  if (!owner) return null;
  const block = await readMajorGateBlock(owner);
  if (!block || !app.composeService) return block;

  const services = block.services.filter((entry) => entry.service === app.composeService);
  return services.length > 0 ? { ...block, services } : null;
}

export async function getAppUpdateStatus(
  app: UpdatableApp & { id?: string; composeOwnerId?: string },
  rules: IgnoreRule[] = [],
): Promise<AppUpdateStatus> {
  const entries = appImages(app);
  const [cached, blockedMigration] = await Promise.all([
    readCachedChecks(entries.map((entry) => refCacheKey(entry.ref))),
    blockFor(app),
  ]);
  const all = buildServices(app, cached, Date.now() - CHECK_TTL_MS);
  const { services, ignored } = partition(all, app.id, indexRules(rules), Date.now());
  return { services, ignored, ...rollUp(services), blockedMigration };
}

export interface AggregateUpdateStatus {
  appsWithUpdates: { id: string; name: string; displayName: string; count: number }[];
  totalUpdates: number;
  unknownCount: number;
  /** Set while a registry rate limit is being waited out. */
  cooldownUntil: string | null;
}

type AggregateApp = UpdatableApp & { id: string; name: string; displayName: string };

export interface FleetAppUpdates {
  appId: string;
  /** URL slug, for linking back to the app's own updates tab. */
  name: string;
  displayName: string;
  services: ServiceUpdateStatus[];
  updateCount: number;
  highestSeverity: BumpSeverity | null;
}

export interface FleetIgnoredUpdate extends IgnoredUpdate {
  appId: string;
  name: string;
  displayName: string;
}

export interface FleetUpdateStatus {
  /** Apps with at least one actionable service, worst severity first. */
  apps: FleetAppUpdates[];
  totalUpdates: number;
  unknownCount: number;
  cooldownUntil: string | null;
  /** Updates a rule is hiding, so the list stays reversible. */
  ignored: FleetIgnoredUpdate[];
}

/**
 * Every actionable service across the fleet, in one cache read. The rows are
 * the same shape the per-app panel renders, so `/updates` is that screen at
 * fleet scope rather than a second implementation of it.
 */
export async function getFleetUpdateStatus(
  orgId: string,
  appRows: AggregateApp[],
  cooldownUntil: number,
): Promise<FleetUpdateStatus> {
  const keys = appRows.flatMap((app) => appImages(app).map((entry) => refCacheKey(entry.ref)));
  const [cached, rules] = await Promise.all([
    readCachedChecks([...new Set(keys)]),
    readIgnoreRules(orgId),
  ]);
  const now = Date.now();
  const cutoff = now - CHECK_TTL_MS;
  const ruleIndex = indexRules(rules);

  const apps: FleetAppUpdates[] = [];
  const ignoredAll: FleetIgnoredUpdate[] = [];
  let totalUpdates = 0;
  let unknownCount = 0;

  for (const app of appRows) {
    const all = buildServices(app, cached, cutoff);
    const { services, ignored } = partition(all, app.id, ruleIndex, now);
    const { updateCount, highestSeverity, hasUnknown } = rollUp(services);

    for (const entry of ignored) {
      ignoredAll.push({
        ...entry,
        appId: app.id,
        name: app.name,
        displayName: app.displayName,
      });
    }
    if (hasUnknown) {
      unknownCount += services.filter((s) => s.status === "unknown").length;
    }
    if (updateCount === 0) continue;

    apps.push({
      appId: app.id,
      name: app.name,
      displayName: app.displayName,
      services: services.filter(isActionable),
      updateCount,
      highestSeverity,
    });
    totalUpdates += updateCount;
  }

  apps.sort(
    (a, b) =>
      SEVERITY_RANK[b.highestSeverity ?? "unknown"] - SEVERITY_RANK[a.highestSeverity ?? "unknown"] ||
      a.displayName.localeCompare(b.displayName),
  );
  ignoredAll.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return {
    apps,
    totalUpdates,
    unknownCount,
    ignored: ignoredAll,
    cooldownUntil: cooldownUntil > now ? new Date(cooldownUntil).toISOString() : null,
  };
}

/** Rolls per-app state up for the org-wide banner. One cache read, no fan-out. */
export async function getAggregateUpdateStatus(
  orgId: string,
  appRows: AggregateApp[],
  cooldownUntil: number,
): Promise<AggregateUpdateStatus> {
  const fleet = await getFleetUpdateStatus(orgId, appRows, cooldownUntil);
  return {
    appsWithUpdates: fleet.apps.map((app) => ({
      id: app.appId,
      name: app.name,
      displayName: app.displayName,
      count: app.updateCount,
    })),
    totalUpdates: fleet.totalUpdates,
    unknownCount: fleet.unknownCount,
    cooldownUntil: fleet.cooldownUntil,
  };
}
