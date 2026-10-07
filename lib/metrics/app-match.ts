// Which cAdvisor rows belong to one app, matched on Docker labels.
// x-vardo-shared services never get vardo labels (--no-recreate), so they match by compose project name.

import type { ContainerInfo } from "@/lib/docker/client";
import { matchContainers, type ReconcilableApp } from "@/lib/docker/container-match";
import { composeProjectApp, composeProjectEnvironment } from "@/lib/docker/slot-partition";
import { dedupeByContainer } from "./aggregate";
import type { ContainerMetrics } from "./types";

/** An app row as far as metrics matching is concerned. */
export type MetricsApp = ReconcilableApp & { organizationId?: string | null };

/** A cAdvisor row in the shape the Docker matcher reads. */
function asContainer(m: ContainerMetrics): ContainerInfo {
  return {
    id: m.containerIdFull || m.containerId,
    name: m.containerName,
    image: "",
    state: "",
    status: "",
    ports: [],
    labels: m.labels,
  };
}

type MetricsEntry = readonly [ContainerInfo, ContainerMetrics];

function toEntries(metrics: ContainerMetrics[]): MetricsEntry[] {
  return metrics.map((m) => [asContainer(m), m] as const);
}

/** Vardo's app id, absent on anything it didn't recreate. */
function appId(m: ContainerMetrics): string | undefined {
  return m.labels["vardo.project.id"] ?? m.labels["host.project.id"];
}

/** An app's shared services, keyed on the compose project name. The label matcher stops at the first hit. */
function sharedEntries(app: MetricsApp, entries: MetricsEntry[]): ContainerMetrics[] {
  return entries
    .filter(([, m]) => !appId(m))
    .filter(([, m]) => {
      const project = m.labels["com.docker.compose.project"];
      return !!project && composeProjectApp(project) === app.name;
    })
    .map(([, m]) => m);
}

function matchEntries(app: MetricsApp, entries: MetricsEntry[]): ContainerMetrics[] {
  // An unlabeled container belongs to no org yet and stays matchable by name.
  const scoped = app.organizationId
    ? entries.filter(([, m]) => m.organizationId === null || m.organizationId === app.organizationId)
    : entries;

  const byContainer = new Map(scoped);
  const matched = matchContainers(app, [...byContainer.keys()]).map((c) => byContainer.get(c)!);
  return dedupeMetrics([matched, sharedEntries(app, scoped)]);
}

/** Metrics for one app. A stack child gets only its own service. */
export function matchAppMetrics(app: MetricsApp, metrics: ContainerMetrics[]): ContainerMetrics[] {
  return matchEntries(app, toEntries(metrics));
}

/** Environment a row belongs to, falling back to a shared service's project name. */
export function metricsEnvironment(m: ContainerMetrics): string | null {
  const labeled = m.labels["vardo.environment"] ?? m.labels["host.environment"];
  if (labeled) return labeled;
  const project = m.labels["com.docker.compose.project"];
  return project ? composeProjectEnvironment(project) : null;
}

/** Narrows a match to one environment. Rows naming none are kept. */
export function filterByEnvironment(
  metrics: ContainerMetrics[],
  environmentName: string,
): ContainerMetrics[] {
  return metrics.filter((m) => {
    const env = metricsEnvironment(m);
    return env === null || env === environmentName;
  });
}

/** Each app's own metrics, keyed by app id. */
export function groupMetricsByApp<T extends MetricsApp>(
  apps: T[],
  metrics: ContainerMetrics[],
): Map<string, ContainerMetrics[]> {
  const entries = toEntries(metrics);
  return new Map(apps.map((app) => [app.id, matchEntries(app, entries)]));
}

/** One entry per container across several apps' matches. Stack children would otherwise count twice. */
export function dedupeMetrics(groups: Iterable<ContainerMetrics[]>): ContainerMetrics[] {
  return dedupeByContainer(groups);
}
