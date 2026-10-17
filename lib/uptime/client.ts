// The seam for running uptime outside Vardo. Vardo uses uptime only through this interface, which
// mirrors the REST API. Today it calls the service in process; later an HTTP implementation can replace it.

import * as domainReads from "./domains";
import * as engine from "./engine";
import type { LinkPatch } from "./link";
import * as health from "./health";
import * as links from "./links";
import * as peers from "./peers";
import * as service from "./service";
import type {
  AppUptime,
  DomainCheck,
  DomainCheckHistory,
  DetectedHealth,
  DomainReachability,
  ReviewItem,
  RecentDomainCheck,
  CreateMonitorInput,
  MonitorDetail,
  MonitorSummary,
  Scope,
  UpdateMonitorInput,
  UptimeRange,
  VantageLinkView,
  VantageView,
} from "./types";

export interface UptimeClient {
  listMonitors(scope: Scope, range?: UptimeRange): Promise<MonitorSummary[]>;
  getMonitor(scope: Scope, monitorId: string, range?: UptimeRange): Promise<MonitorDetail | null>;
  createMonitor(scope: Scope, input: CreateMonitorInput): Promise<MonitorSummary>;
  updateMonitor(scope: Scope, monitorId: string, patch: UpdateMonitorInput): Promise<MonitorSummary | null>;
  setMuted(scope: Scope, monitorId: string, muted: boolean): Promise<MonitorSummary | null>;
  /** Manual monitors are deleted; automatic ones report "auto" and stay. */
  deleteMonitor(scope: Scope, monitorId: string): Promise<"deleted" | "auto" | "missing">;
  getAppUptime(orgId: string, appId: string, range?: UptimeRange): Promise<AppUptime>;
  /** Reachability of these domains, for those with an automatic monitor turned on. */
  domainReachability(orgId: string, domainIds: string[]): Promise<DomainReachability[]>;
  /** Production domain checks in [from, to), for the hourly rollup. */
  domainChecks(fromMs: number, toMs: number): Promise<DomainCheck[]>;
  /** Past outcomes of these apps' domains for away summaries. */
  domainCheckHistory(appIds: string[], baselineFromMs: number, sinceMs: number): Promise<DomainCheckHistory>;
  /** The newest checks of each domain, newest first. */
  recentDomainChecks(orgId: string, domainIds: string[], perDomain: number): Promise<RecentDomainCheck[]>;
  /** Looks for a health endpoint at a URL without saving anything. */
  detectHealth(scope: Scope, url: string, headers?: Record<string, string>): Promise<DetectedHealth>;
  /** Stores the operator's answer for a monitor that needs review. False when the monitor isn't an automatic HTTP monitor of this scope. */
  answerReview(scope: Scope, monitorId: string, answer: health.ReviewInput): Promise<boolean>;
  /** Monitors of the org waiting on an answer. */
  listReviews(orgId: string): Promise<ReviewItem[]>;
  /** Runs health detection for the app's automatic monitors on the next pass, such as after a deploy. */
  requestHealthDetection(appId: string): Promise<void>;
  listVantages(): Promise<VantageView[]>;
  /** Linked instances with their two uptime switches. */
  listVantageLinks(): Promise<VantageLinkView[]>;
  setVantageLink(peerId: string, patch: LinkPatch): Promise<VantageLinkView | null>;
  /** Whether uptime watches this linked instance and alerts when it goes quiet, so the heartbeat watcher stays silent about it. */
  watchesPeer(peerId: string): Promise<boolean>;
  /** Matches automatic monitors to the apps' domains and previews. */
  syncAutoMonitors(): Promise<{ added: number; removed: number }>;
  /** One worker pass: due checks, rollups, alerts and retention. */
  tick(): Promise<void>;
}

export const inProcessUptimeClient: UptimeClient = {
  listMonitors: (scope, range) => service.listMonitors(scope, Date.now(), range),
  getMonitor: (scope, id, range) => service.getMonitor(scope, id, Date.now(), range),
  createMonitor: (scope, input) => service.createMonitor(scope, input),
  updateMonitor: (scope, id, patch) => service.updateMonitor(scope, id, patch),
  setMuted: (scope, id, muted) => service.setMuted(scope, id, muted),
  deleteMonitor: (scope, id) => service.deleteMonitor(scope, id),
  getAppUptime: (orgId, appId, range) => service.getAppUptime(orgId, appId, Date.now(), range),
  domainReachability: (orgId, ids) => domainReads.domainReachability(orgId, ids),
  domainChecks: (from, to) => domainReads.domainChecks(from, to),
  domainCheckHistory: (appIds, baseline, since) => domainReads.domainCheckHistory(appIds, baseline, since),
  recentDomainChecks: (orgId, ids, n) => domainReads.recentDomainChecks(orgId, ids, n),
  detectHealth: (scope, url, headers) => health.detectForUrl(scope, url, headers),
  answerReview: (scope, id, answer) => health.answerReview(scope, id, answer),
  listReviews: (orgId) => health.listReviews(orgId),
  requestHealthDetection: (appId) => health.requestHealthDetection(appId),
  listVantages: () => service.listVantages(),
  listVantageLinks: () => links.listVantageLinks(),
  setVantageLink: (peerId, patch) => links.setVantageLink(peerId, patch),
  watchesPeer: (peerId) => peers.watchesPeer(peerId),
  syncAutoMonitors: () => engine.syncAutoMonitors(),
  tick: () => engine.tickUptime(),
};

export const uptimeClient: UptimeClient = inProcessUptimeClient;
