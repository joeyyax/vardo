// The seam for running uptime outside Vardo. Vardo uses uptime only through this interface, which
// mirrors the REST API. Today it calls the service in process; later an HTTP implementation can replace it.

import * as engine from "./engine";
import type { LinkPatch } from "./link";
import * as links from "./links";
import * as peers from "./peers";
import * as service from "./service";
import type {
  AppUptime,
  CreateMonitorInput,
  MonitorDetail,
  MonitorSummary,
  Scope,
  UpdateMonitorInput,
  VantageLinkView,
  VantageView,
} from "./types";

export interface UptimeClient {
  listMonitors(scope: Scope): Promise<MonitorSummary[]>;
  getMonitor(scope: Scope, monitorId: string): Promise<MonitorDetail | null>;
  createMonitor(scope: Scope, input: CreateMonitorInput): Promise<MonitorSummary>;
  updateMonitor(scope: Scope, monitorId: string, patch: UpdateMonitorInput): Promise<MonitorSummary | null>;
  setMuted(scope: Scope, monitorId: string, muted: boolean): Promise<MonitorSummary | null>;
  /** Manual monitors are deleted; automatic ones report "auto" and stay. */
  deleteMonitor(scope: Scope, monitorId: string): Promise<"deleted" | "auto" | "missing">;
  getAppUptime(orgId: string, appId: string): Promise<AppUptime>;
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
  listMonitors: (scope) => service.listMonitors(scope),
  getMonitor: (scope, id) => service.getMonitor(scope, id),
  createMonitor: (scope, input) => service.createMonitor(scope, input),
  updateMonitor: (scope, id, patch) => service.updateMonitor(scope, id, patch),
  setMuted: (scope, id, muted) => service.setMuted(scope, id, muted),
  deleteMonitor: (scope, id) => service.deleteMonitor(scope, id),
  getAppUptime: (orgId, appId) => service.getAppUptime(orgId, appId),
  listVantages: () => service.listVantages(),
  listVantageLinks: () => links.listVantageLinks(),
  setVantageLink: (peerId, patch) => links.setVantageLink(peerId, patch),
  watchesPeer: (peerId) => peers.watchesPeer(peerId),
  syncAutoMonitors: () => engine.syncAutoMonitors(),
  tick: () => engine.tickUptime(),
};

export const uptimeClient: UptimeClient = inProcessUptimeClient;
