import { isVardoManagedApp } from "@/lib/infra/instance-apps";
import { refCacheKey } from "./image-ref";
import { appImages, type UpdatableApp } from "./compose-images";
import { readCachedChecks, CHECK_TTL_MS } from "./check";
import { indexRules, silencedBy, type IgnoreRule } from "./ignore";
import { readIgnoreRules } from "./read-ignores";
import { readTrackPolicies } from "./read-tracks";
import { readMajorGateBlock } from "./major-gate-store";
import { splitCheck, resurfaceReasons, runningMajor, type ResurfaceReason } from "./majors";
import { indexTracks, resolveTrack, type ResolvedTrack, type TrackMode, type TrackPolicy } from "./track-policy";
import type { MajorGateBlock } from "./major-gate";
import type { BumpSeverity } from "./tag-version";
import type { CheckStatus } from "./check";

// Read-only view over the check cache; never calls a registry.
// Vardo-managed apps are reported but excluded from actionable counts.
// Updates stay within the running major; new majors are informational and never counted.

/** Name and flag needed to tell a Vardo-pinned app from a tenant's. */
type Identity = { name?: string | null; isSystemManaged?: boolean | null };

export interface ServiceUpdateStatus {
  service: string | null;
  image: string;
  currentTag: string;
  status: CheckStatus;
  /** Newest tag within the running major. */
  latestTag: string | null;
  severity: BumpSeverity | null;
  unorderable: string[];
  /** Newer tags within the running major, newest first. */
  available: string[];
  /** Newest tag crossing a major. Never counted as an update. */
  majorAvailable: string | null;
  /** Every tag on a higher major, newest first. */
  majorTags: string[];
  /** Which major this service follows. */
  track: ResolvedTrack & { major: number | null };
  /** A new major exists and a stay-on-major policy or an ignore rule holds it. */
  majorHeld: boolean;
  /** Why the running major needs a decision now. Empty when it doesn't. */
  reasons: ResurfaceReason[];
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
  /** Services with a newer tag in the running major or a drifted floating tag. */
  updateCount: number;
  /** Highest severity among available updates, for UI emphasis. */
  highestSeverity: BumpSeverity | null;
  /** True when at least one service could not be answered. */
  hasUnknown: boolean;
  /** New majors offered under "follow latest". Informational, outside `updateCount`. */
  majorCount: number;
  /** New majors held by a stay-on-major policy or an ignore rule. */
  heldCount: number;
  /** Actionable updates withheld by an ignore rule. */
  ignored: IgnoredUpdate[];
  /** A deploy the major gate stopped, still waiting on a decision. */
  blockedMigration: MajorGateBlock | null;
  /** Vardo pins these tags; the apply path refuses them. Counts stay at zero. */
  selfManaged: boolean;
}

const SEVERITY_RANK: Record<BumpSeverity, number> = {
  build: 1,
  patch: 2,
  minor: 3,
  major: 4,
  unknown: 0,
};

type CachedChecks = Awaited<ReturnType<typeof readCachedChecks>>;

interface BuildContext {
  cached: CachedChecks;
  cutoff: number;
  now: number;
  /** App that owns the compose. Track policies are keyed by it. */
  ownerId: string | undefined;
  tracks: Map<string, TrackMode>;
}

function buildServices(app: UpdatableApp, ctx: BuildContext): ServiceUpdateStatus[] {
  return appImages(app).map((entry) => {
    const row = ctx.cached.get(refCacheKey(entry.ref));
    const currentTag = entry.ref.tag;
    const split = splitCheck(currentTag, {
      latestTag: row?.latestTag ?? null,
      severity: (row?.severity as BumpSeverity | null) ?? null,
      available: row?.available ?? [],
      majorAvailable: row?.majorAvailable ?? null,
    });
    // Older rows marked a major-only result as an update.
    const status: CheckStatus =
      row?.status === "update" && !split.latestTag ? "current" : (row?.status ?? "unknown");
    const track = resolveTrack(ctx.tracks, ctx.ownerId, entry.service, entry.image);

    return {
      service: entry.service,
      image: entry.image,
      currentTag,
      status,
      latestTag: split.latestTag,
      severity: split.severity,
      unorderable: row?.unorderable ?? [],
      available: split.available,
      majorAvailable: split.majorAvailable,
      majorTags: split.majorTags,
      track: { ...track, major: runningMajor(currentTag) },
      majorHeld: split.majorAvailable !== null && track.mode === "major",
      reasons: resurfaceReasons(
        { image: entry.image, currentTag, majorAvailable: split.majorAvailable },
        ctx.now,
      ),
      majorLocked: row?.majorLocked ?? false,
      error: row?.error ?? (row ? null : "Not checked yet"),
      checkedAt: row?.checkedAt.toISOString() ?? null,
      stale: !row || row.checkedAt.getTime() < ctx.cutoff,
    };
  });
}

/** An update within the running major, or a drifted floating tag. Majors never count. */
export function isActionable(service: ServiceUpdateStatus): boolean {
  return service.status === "update" || service.status === "drift";
}

/** A new major is out and nothing holds it. */
export function isOfferedMajor(service: ServiceUpdateStatus): boolean {
  return service.majorAvailable !== null && !service.majorHeld;
}

/** Splits an app's services into shown and ignored-by-rule. Any active rule also holds the major. */
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
    const holds =
      service.majorAvailable !== null &&
      silencedBy(rules, { appId, service: service.service, severity: "major" }, now) !== null;
    const current = holds ? { ...service, majorHeld: true } : service;
    const rule = isActionable(current)
      ? silencedBy(rules, { appId, service: current.service, severity: current.severity }, now)
      : null;
    if (rule) ignored.push({ service: current, rule });
    else kept.push(current);
  }
  return { services: kept, ignored };
}

function rollUp(
  services: ServiceUpdateStatus[],
): Omit<AppUpdateStatus, "services" | "ignored" | "blockedMigration" | "selfManaged"> {
  let highest: BumpSeverity | null = null;
  let updateCount = 0;
  let hasUnknown = false;
  let majorCount = 0;
  let heldCount = 0;

  for (const service of services) {
    if (service.status === "unknown") hasUnknown = true;
    if (isOfferedMajor(service)) majorCount++;
    else if (service.majorHeld) heldCount++;
    if (!isActionable(service)) continue;
    updateCount++;
    const severity = service.severity ?? "unknown";
    if (!highest || SEVERITY_RANK[severity] > SEVERITY_RANK[highest]) highest = severity;
  }

  return { updateCount, highestSeverity: highest, hasUnknown, majorCount, heldCount };
}

/** The major gate's block, narrowed to this app. A child service reads the parent's block. */
async function blockFor(app: UpdatableApp & { id?: string; composeOwnerId?: string }) {
  const owner = app.composeOwnerId ?? app.id;
  if (!owner) return null;
  const block = await readMajorGateBlock(owner);
  if (!block || !app.composeService) return block;

  const services = block.services.filter((entry) => entry.service === app.composeService);
  return services.length > 0 ? { ...block, services } : null;
}

export async function getAppUpdateStatus(
  app: UpdatableApp & Identity & { id?: string; composeOwnerId?: string },
  rules: IgnoreRule[] = [],
  tracks: TrackPolicy[] = [],
): Promise<AppUpdateStatus> {
  const entries = appImages(app);
  const [cached, blockedMigration] = await Promise.all([
    readCachedChecks(entries.map((entry) => refCacheKey(entry.ref))),
    blockFor(app),
  ]);
  const now = Date.now();
  const all = buildServices(app, {
    cached,
    cutoff: now - CHECK_TTL_MS,
    now,
    ownerId: app.composeOwnerId ?? app.id,
    tracks: indexTracks(tracks),
  });
  const selfManaged = isVardoManagedApp(app);

  // Rows stay visible; counts stay zero since the apply path refuses these.
  if (selfManaged) {
    return {
      services: all,
      ignored: [],
      updateCount: 0,
      highestSeverity: null,
      hasUnknown: false,
      majorCount: 0,
      heldCount: 0,
      blockedMigration,
      selfManaged,
    };
  }

  const { services, ignored } = partition(all, app.id, indexRules(rules), now);
  return { services, ignored, ...rollUp(services), blockedMigration, selfManaged };
}

/** A service with a newer major, or a running major that needs a decision. */
export interface MajorNotice {
  appId: string;
  name: string;
  displayName: string;
  service: ServiceUpdateStatus;
}

export interface AggregateUpdateStatus {
  appsWithUpdates: { id: string; name: string; displayName: string; count: number }[];
  /** Updates within the running major. New majors are never in this count. */
  totalUpdates: number;
  /** Running majors at or near end of life, or with a fix only in a newer major. */
  majorNotices: MajorNotice[];
  unknownCount: number;
  /** Set while a registry rate limit is being waited out. */
  cooldownUntil: string | null;
}

type AggregateApp = UpdatableApp &
  Identity & { id: string; name: string; displayName: string };

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
  /** Vardo-pinned apps that are behind upstream. Reported, never offered. */
  selfManaged: FleetAppUpdates[];
  /** Every service with a newer major, offered first, then held. Informational. */
  majors: MajorNotice[];
  /** Running majors with a reason to decide now. */
  majorNotices: MajorNotice[];
}

/** Every actionable service across the fleet, in one cache read. */
export async function getFleetUpdateStatus(
  orgId: string,
  appRows: AggregateApp[],
  cooldownUntil: number,
): Promise<FleetUpdateStatus> {
  const keys = appRows.flatMap((app) => appImages(app).map((entry) => refCacheKey(entry.ref)));
  const [cached, rules, trackRows] = await Promise.all([
    readCachedChecks([...new Set(keys)]),
    readIgnoreRules(orgId),
    readTrackPolicies(orgId),
  ]);
  const now = Date.now();
  const cutoff = now - CHECK_TTL_MS;
  const ruleIndex = indexRules(rules);
  const tracks = indexTracks(trackRows);

  const apps: FleetAppUpdates[] = [];
  const selfManaged: FleetAppUpdates[] = [];
  const ignoredAll: FleetIgnoredUpdate[] = [];
  const majors: MajorNotice[] = [];
  const majorNotices: MajorNotice[] = [];
  let totalUpdates = 0;
  let unknownCount = 0;

  for (const app of appRows) {
    const all = buildServices(app, { cached, cutoff, now, ownerId: app.id, tracks });

    // Vardo-managed apps are listed separately, outside totals and ignore rules.
    if (isVardoManagedApp(app)) {
      const behind = all.filter(isActionable);
      if (behind.length > 0) {
        selfManaged.push({
          appId: app.id,
          name: app.name,
          displayName: app.displayName,
          services: behind,
          updateCount: behind.length,
          highestSeverity: rollUp(behind).highestSeverity,
        });
      }
      continue;
    }

    const { services, ignored } = partition(all, app.id, ruleIndex, now);
    const { updateCount, highestSeverity, hasUnknown } = rollUp(services);

    const identity = { appId: app.id, name: app.name, displayName: app.displayName };
    for (const service of [...services, ...ignored.map((entry) => entry.service)]) {
      if (service.majorAvailable) majors.push({ ...identity, service });
      if (service.reasons.length > 0) majorNotices.push({ ...identity, service });
    }

    for (const entry of ignored) {
      ignoredAll.push({ ...entry, ...identity });
    }
    if (hasUnknown) {
      unknownCount += services.filter((s) => s.status === "unknown").length;
    }
    if (updateCount === 0) continue;

    apps.push({
      ...identity,
      services: services.filter(isActionable),
      updateCount,
      highestSeverity,
    });
    totalUpdates += updateCount;
  }

  const bySeverity = (a: FleetAppUpdates, b: FleetAppUpdates) =>
    SEVERITY_RANK[b.highestSeverity ?? "unknown"] - SEVERITY_RANK[a.highestSeverity ?? "unknown"] ||
    a.displayName.localeCompare(b.displayName);

  apps.sort(bySeverity);
  selfManaged.sort(bySeverity);
  ignoredAll.sort((a, b) => a.displayName.localeCompare(b.displayName));
  majors.sort(
    (a, b) =>
      Number(a.service.majorHeld) - Number(b.service.majorHeld) ||
      a.displayName.localeCompare(b.displayName),
  );
  majorNotices.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return {
    apps,
    totalUpdates,
    unknownCount,
    ignored: ignoredAll,
    selfManaged,
    majors,
    majorNotices,
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
    majorNotices: fleet.majorNotices,
    unknownCount: fleet.unknownCount,
    cooldownUntil: fleet.cooldownUntil,
  };
}
