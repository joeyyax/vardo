// The /v1/self payload: operational facts Vardo already holds about the calling app. Never env values or secrets.

import { and, desc, eq, inArray, max } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  apps,
  backupJobApps,
  backupJobVolumes,
  backupJobs,
  backups,
  domainCertChecks,
  domains,
  environments,
  volumes,
} from "@/lib/db/schema";
import { projectNetworkName } from "@/lib/docker/project-network";
import type { ExitReason } from "@/lib/docker/exit-reason";
import type { ContainerMetrics } from "@/lib/metrics/types";
import type { MetadataCaller, Refusal } from "./caller";

export const METADATA_VERSION = 1;
const CACHE_MS = 5_000;
const DAY_MS = 86_400_000;

export type BackupState = "ok" | "overdue" | "on-hold" | "none";

export type SelfMetadata = {
  version: typeof METADATA_VERSION;
  generatedAt: string;
  app: { id: string; name: string; displayName: string | null; service: string | null; url: string | null };
  environment: { name: string; type: string | null };
  deploy: { id: string; sha: string | null; branch: string | null; deployedAt: string | null; slot: "blue" | "green" | null } | null;
  resources: {
    container: { id: string; memoryUsedBytes: number; memoryLimitBytes: number | null; cpuPercent: number } | null;
    restarts: { count: number; since: string | null } | null;
    oomKills: { lastHour: number; lastAt: string | null };
  };
  uptime: {
    state: string;
    uptime24h: number | null;
    uptime30d: number | null;
    medianResponseMs: number | null;
    lastCheckedAt: string | null;
  } | null;
  certs: { domain: string; daysLeft: number | null; expiresAt: string | null; status: string; checkedAt: string }[];
  backups: { state: BackupState; lastSuccessAt: string | null };
};

/** The app row columns the payload reads. */
export type SelfApp = {
  id: string;
  name: string;
  displayName: string | null;
  organizationId: string;
  projectId: string | null;
  parentAppId: string | null;
  composeService: string | null;
  metadataEndpoint: boolean;
  status: string;
  containerName: string | null;
  importedContainerId: string | null;
  containerRestartCount: number | null;
  containerRestartSince: Date | null;
  exitReason: ExitReason | null;
};

/** Facts for one app and environment, shared by its containers. */
export type AppFacts = Omit<SelfMetadata, "version" | "generatedAt" | "resources"> & {
  restarts: SelfMetadata["resources"]["restarts"];
  oomKills: SelfMetadata["resources"]["oomKills"];
  metrics: ContainerMetrics[];
};

/** Where each fact comes from; injectable for tests. */
export type MetadataSources = {
  app: (appId: string) => Promise<SelfApp | null>;
  child: (parentId: string, service: string) => Promise<SelfApp | null>;
  environment: (appId: string, name: string) => Promise<{ id: string; type: string | null } | null>;
  deployVars: (appId: string, environmentId: string | null) => Promise<Record<string, string> | null>;
  metrics: (app: SelfApp) => Promise<ContainerMetrics[]>;
  oomKills: (appId: string, now: number) => Promise<{ kills: number; lastAt: number }[]>;
  uptime: (orgId: string, appId: string) => Promise<SelfMetadata["uptime"]>;
  certs: (appId: string, now: number) => Promise<SelfMetadata["certs"]>;
  backups: (appId: string, now: Date) => Promise<SelfMetadata["backups"]>;
};

const appColumns = {
  id: true,
  name: true,
  displayName: true,
  organizationId: true,
  projectId: true,
  parentAppId: true,
  composeService: true,
  metadataEndpoint: true,
  status: true,
  containerName: true,
  importedContainerId: true,
  containerRestartCount: true,
  containerRestartSince: true,
  exitReason: true,
} as const;

/** Swallows a failed optional source, so one slow store never fails the whole payload. */
async function optional<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

export const dbSources: MetadataSources = {
  app: async (appId) => ((await db.query.apps.findFirst({ where: eq(apps.id, appId), columns: appColumns })) as SelfApp | undefined) ?? null,
  child: async (parentId, service) =>
    ((await db.query.apps.findFirst({
      where: and(eq(apps.parentAppId, parentId), eq(apps.composeService, service)),
      columns: appColumns,
    })) as SelfApp | undefined) ?? null,
  environment: async (appId, name) =>
    (await db.query.environments.findFirst({
      where: and(eq(environments.appId, appId), eq(environments.name, name)),
      columns: { id: true, type: true },
    })) ?? null,
  deployVars: async (appId, environmentId) => {
    const { servingDeployVars } = await import("@/lib/docker/serving-deploy-vars");
    return (await servingDeployVars(appId, environmentId))?.vars ?? null;
  },
  metrics: async (app) => {
    const { fetchAppMetrics } = await import("@/lib/metrics/provider");
    return fetchAppMetrics(app);
  },
  oomKills: async (appId, now) => {
    const { sharedOomKills } = await import("@/lib/alerts/oom");
    return (await sharedOomKills(now)).filter((r) => r.appId === appId);
  },
  uptime: async (orgId, appId) => {
    const { getAppUptime } = await import("@/lib/uptime/service");
    const u = await getAppUptime(orgId, appId);
    if (u.monitors.length === 0) return null;
    return {
      state: u.state,
      uptime24h: u.uptime24h,
      uptime30d: u.uptime30d,
      medianResponseMs: u.medianLatency24h,
      lastCheckedAt: u.lastCheckedAt ? new Date(u.lastCheckedAt).toISOString() : null,
    };
  },
  certs: async (appId, now) => {
    const rows = await db
      .select({ domain: domains.domain, expiresAt: domainCertChecks.expiresAt, status: domainCertChecks.status, checkedAt: domainCertChecks.checkedAt })
      .from(domains)
      .innerJoin(domainCertChecks, eq(domainCertChecks.domainId, domains.id))
      .where(and(eq(domains.appId, appId), eq(domains.enabled, true)));
    return rows.map((r) => ({
      domain: r.domain,
      daysLeft: r.expiresAt ? Math.floor((r.expiresAt.getTime() - now) / DAY_MS) : null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      status: r.status,
      checkedAt: r.checkedAt.toISOString(),
    }));
  },
  backups: async (appId, now) => {
    const [last] = await db
      .select({ at: max(backups.finishedAt) })
      .from(backups)
      .where(and(eq(backups.appId, appId), eq(backups.status, "success")));
    const [linked, viaVolume] = await Promise.all([
      db.select({ id: backupJobApps.backupJobId }).from(backupJobApps).where(eq(backupJobApps.appId, appId)),
      db
        .select({ id: backupJobVolumes.backupJobId })
        .from(backupJobVolumes)
        .innerJoin(volumes, eq(volumes.id, backupJobVolumes.volumeId))
        .where(eq(volumes.appId, appId)),
    ]);
    const jobIds = [...new Set([...linked, ...viaVolume].map((r) => r.id))];
    const lastSuccessAt = last?.at?.toISOString() ?? null;
    if (jobIds.length === 0) return { state: "none", lastSuccessAt };
    const jobs = await db
      .select({ id: backupJobs.id, name: backupJobs.name, schedule: backupJobs.schedule, enabled: backupJobs.enabled, lastRunAt: backupJobs.lastRunAt, createdAt: backupJobs.createdAt })
      .from(backupJobs)
      .where(inArray(backupJobs.id, jobIds))
      .orderBy(desc(backupJobs.createdAt));
    const enabled = jobs.filter((j) => j.enabled);
    if (enabled.length === 0) return { state: "none", lastSuccessAt };
    const { withJobApps } = await import("@/lib/backups/job-apps");
    const { backupJobStaleness } = await import("@/lib/backups/staleness");
    const { overdue, stopped } = backupJobStaleness(await withJobApps(enabled, now), now);
    const state: BackupState = overdue.length > 0 ? "overdue" : stopped.length > 0 ? "on-hold" : "ok";
    return { state, lastSuccessAt };
  },
};

function deployOf(vars: Record<string, string> | null): SelfMetadata["deploy"] {
  if (!vars?.VARDO_DEPLOY_ID) return null;
  const slot = vars.VARDO_SLOT === "blue" || vars.VARDO_SLOT === "green" ? vars.VARDO_SLOT : null;
  return {
    id: vars.VARDO_DEPLOY_ID,
    sha: vars.VARDO_GIT_SHA ?? null,
    branch: vars.VARDO_GIT_BRANCH ?? null,
    deployedAt: vars.VARDO_DEPLOYED_AT ?? null,
    slot,
  };
}

function oomOf(records: { kills: number; lastAt: number }[], exit: ExitReason | null): AppFacts["oomKills"] {
  const lastHour = records.reduce((n, r) => n + r.kills, 0);
  const times = records.map((r) => r.lastAt);
  if (exit?.kind === "oom-host" || exit?.kind === "oom-limit") {
    const at = Date.parse(exit.at);
    if (Number.isFinite(at)) times.push(at);
  }
  return { lastHour, lastAt: times.length ? new Date(Math.max(...times)).toISOString() : null };
}

/** The app a container belongs to: its compose service's child app when there is one. Refuses one off its own project network. */
export async function resolveSelfApp(caller: MetadataCaller, sources: MetadataSources): Promise<SelfApp | Refusal> {
  const owner = await sources.app(caller.appId);
  if (!owner) return { status: 403, error: "Unknown caller" };
  if (!owner.projectId || projectNetworkName(owner.projectId, caller.envName) !== caller.network) {
    return { status: 403, error: "Unknown caller" };
  }
  const self = (caller.service && !owner.parentAppId && (await sources.child(owner.id, caller.service))) || owner;
  if (!self.metadataEndpoint) return { status: 404, error: "The metadata endpoint is off for this app" };
  return self;
}

/** App-wide facts, loaded in parallel. */
export async function loadAppFacts(app: SelfApp, envName: string, sources: MetadataSources, now = Date.now()): Promise<AppFacts> {
  const env = await optional(sources.environment(app.id, envName), null);
  const [vars, metrics, ooms, uptime, certs, backupFacts] = await Promise.all([
    optional(sources.deployVars(app.id, env?.id ?? null), null),
    optional(sources.metrics(app), []),
    optional(sources.oomKills(app.id, now), []),
    optional(sources.uptime(app.organizationId, app.id), null),
    optional(sources.certs(app.id, now), []),
    optional(sources.backups(app.id, new Date(now)), { state: "none" as const, lastSuccessAt: null }),
  ]);
  return {
    app: { id: app.id, name: app.name, displayName: app.displayName, service: app.composeService, url: vars?.VARDO_APP_URL ?? null },
    environment: { name: envName, type: env?.type ?? null },
    deploy: deployOf(vars),
    restarts: app.containerRestartCount === null ? null : { count: app.containerRestartCount, since: app.containerRestartSince?.toISOString() ?? null },
    oomKills: oomOf(ooms, app.exitReason),
    metrics,
    uptime,
    certs,
    backups: backupFacts,
  };
}

/** One container's payload from its app's facts. */
export function assemblePayload(facts: AppFacts, caller: Pick<MetadataCaller, "containerId" | "service">, now = Date.now()): SelfMetadata {
  const { containerId } = caller;
  const own = facts.metrics.find((m) => {
    const id = m.containerIdFull || m.containerId;
    return !!id && (containerId.startsWith(id) || id.startsWith(containerId));
  });
  return {
    version: METADATA_VERSION,
    generatedAt: new Date(now).toISOString(),
    app: { ...facts.app, service: facts.app.service ?? caller.service },
    environment: facts.environment,
    deploy: facts.deploy,
    resources: {
      container: own
        ? { id: containerId, memoryUsedBytes: own.memoryUsage, memoryLimitBytes: own.memoryLimit > 0 ? own.memoryLimit : null, cpuPercent: own.cpuPercent }
        : null,
      restarts: facts.restarts,
      oomKills: facts.oomKills,
    },
    uptime: facts.uptime,
    certs: facts.certs,
    backups: facts.backups,
  };
}

type Cached = { at: number; facts: Promise<AppFacts> };
const cache = new Map<string, Cached>();
const MAX_CACHED = 2_000;

/** App facts cached for CACHE_MS per app and environment; concurrent callers share one load. */
export function cachedAppFacts(app: SelfApp, envName: string, sources: MetadataSources = dbSources, now = Date.now()): Promise<AppFacts> {
  const key = `${app.id}\n${envName}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.facts;
  if (cache.size >= MAX_CACHED) for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
  const facts = loadAppFacts(app, envName, sources, now);
  cache.set(key, { at: now, facts });
  facts.catch(() => cache.delete(key));
  return facts;
}

export function clearMetadataCache(): void {
  cache.clear();
}
