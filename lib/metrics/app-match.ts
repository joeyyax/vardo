// ---------------------------------------------------------------------------
// Which cAdvisor rows belong to one app.
//
// Every container in a compose stack carries the parent's vardo labels, so a
// child resolved by its own name or id matches nothing. cAdvisor's spec
// endpoint returns the Docker labels, so metrics join on the same labels the
// Docker matcher uses and reuse it outright.
// ---------------------------------------------------------------------------

import type { ContainerInfo } from "@/lib/docker/client";
import { matchContainers, type ReconcilableApp } from "@/lib/docker/status-reconcile";
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

function matchEntries(app: MetricsApp, entries: MetricsEntry[]): ContainerMetrics[] {
  // An unlabeled container belongs to no org yet and stays matchable by name.
  const scoped = app.organizationId
    ? entries.filter(([, m]) => m.organizationId === null || m.organizationId === app.organizationId)
    : entries;

  const byContainer = new Map(scoped);
  return matchContainers(app, [...byContainer.keys()]).map((c) => byContainer.get(c)!);
}

/** Metrics for one app alone — a stack child gets only its own service. */
export function matchAppMetrics(app: MetricsApp, metrics: ContainerMetrics[]): ContainerMetrics[] {
  return matchEntries(app, toEntries(metrics));
}

/** Narrow a match to one environment. Containers deployed by Vardo always carry the label. */
export function filterByEnvironment(
  metrics: ContainerMetrics[],
  environmentName: string,
): ContainerMetrics[] {
  return metrics.filter(
    (m) =>
      m.labels["vardo.environment"] === environmentName ||
      m.labels["host.environment"] === environmentName,
  );
}

/** Each app's own metrics, keyed by app id. */
export function groupMetricsByApp<T extends MetricsApp>(
  apps: T[],
  metrics: ContainerMetrics[],
): Map<string, ContainerMetrics[]> {
  const entries = toEntries(metrics);
  return new Map(apps.map((app) => [app.id, matchEntries(app, entries)]));
}

/**
 * One entry per container across several apps' matches. A stack child's
 * containers are a subset of its parent's, so a total built by concatenating
 * per-app matches counts them twice.
 */
export function dedupeMetrics(groups: Iterable<ContainerMetrics[]>): ContainerMetrics[] {
  const byId = new Map<string, ContainerMetrics>();
  for (const group of groups) {
    for (const m of group) byId.set(m.containerId, m);
  }
  return [...byId.values()];
}
