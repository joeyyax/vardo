// Vardo's own containers held near their memory limit: Traefik, Redis, Postgres, BuildKit and the rest.

import type { AlertItem } from "@/lib/bus/events";
import { formatBytesIec } from "@/lib/metrics/format";
import { CORE_SERVICE_DEFS, coreServiceKey } from "@/lib/metrics/core-services";
import type { ContainerMetrics } from "@/lib/metrics/types";
import type { Observation } from "@/lib/notifications/observations";
import type { AlertType } from "@/lib/notifications/registry";
import { judgeThreshold, STALE_MS, type Point, type ThresholdRule } from "./threshold";

export const CORE_MEMORY_TYPE = "host.core-memory" satisfies AlertType;

export const CORE_MEMORY_RULE: ThresholdRule = { warn: 85, critical: 95, clearBelow: 80, sustainMs: 5 * 60_000 };

const KEEP_MS = 60 * 60_000;

/** The .env var that sizes each core service install.sh writes. */
const ENV_VAR: Partial<Record<string, string>> = {
  proxy: "VARDO_TRAEFIK_MEM",
  cache: "VARDO_REDIS_MEM",
  builder: "VARDO_BUILDKIT_MEM",
  worker: "VARDO_WORKER_MEM",
};

/** Named vardo-* with no app id. Slot containers carry one and alert as apps. */
export function isCoreContainer(m: Pick<ContainerMetrics, "containerName" | "labels">): boolean {
  if (m.labels["vardo.project.id"] || m.labels["host.project.id"]) return false;
  return /^\/?vardo-/.test(m.containerName);
}

type Reading = Point & { usage: number; limit: number };

/** Each core container's share of its memory limit over the last hour. */
export class CoreMemoryBuffer {
  private readings = new Map<string, Reading[]>();

  record(snapshot: ContainerMetrics[] | null): void {
    for (const m of snapshot ?? []) {
      if (!isCoreContainer(m) || !(m.memoryLimit > 0)) continue;
      const name = m.containerName.replace(/^\//, "");
      const list = this.readings.get(name) ?? [];
      if (list.at(-1)?.at === m.timestamp) continue;
      list.push({ at: m.timestamp, value: (m.memoryUsage / m.memoryLimit) * 100, usage: m.memoryUsage, limit: m.memoryLimit });
      this.readings.set(name, list);
    }
    const latest = Math.max(0, ...[...this.readings.values()].map((l) => l.at(-1)!.at));
    for (const [name, list] of this.readings) {
      const kept = list.filter((r) => r.at >= latest - KEEP_MS);
      if (kept.length) this.readings.set(name, kept);
      else this.readings.delete(name);
    }
  }

  entries(): [string, Reading[]][] {
    return [...this.readings];
  }
}

function item(name: string, severity: AlertItem["severity"], latest: Reading): AlertItem {
  const key = coreServiceKey({ containerName: name });
  const label = key === "other" ? name : CORE_SERVICE_DEFS[key].label;
  const envVar = ENV_VAR[key];
  const minutes = Math.round(CORE_MEMORY_RULE.sustainMs / 60_000);
  return {
    type: CORE_MEMORY_TYPE,
    about: name,
    severity,
    title: `${label} is near its memory limit`,
    detail:
      key === "proxy"
        ? "If the kernel kills it, every site on this server goes down."
        : "The kernel kills it if it reaches the limit.",
    next: envVar
      ? `Raise ${envVar} in .env and recreate ${name}.`
      : `Raise its mem_limit and recreate ${name}.`,
    gauge: { title: "Memory limit used", percent: latest.value, warn: CORE_MEMORY_RULE.warn, critical: CORE_MEMORY_RULE.critical },
    facts: [
      { label: "Usage", value: `${formatBytesIec(latest.usage)} of ${formatBytesIec(latest.limit)}` },
      { label: "Held", value: `Over ${CORE_MEMORY_RULE.warn}% for ${minutes} min` },
    ],
  };
}

/** Observations for core containers. Evaluated only with a fresh reading, so a metrics gap neither fires nor clears. */
export function coreMemoryObservations(buffer: CoreMemoryBuffer, now: number): { evaluated: AlertType[]; observations: Observation[] } {
  const entries = buffer.entries();
  if (!entries.some(([, list]) => now - list.at(-1)!.at <= STALE_MS)) return { evaluated: [], observations: [] };

  const observations: Observation[] = [];
  for (const [name, list] of entries) {
    const verdict = judgeThreshold(list, CORE_MEMORY_RULE, now);
    if (!verdict?.holds) continue;
    observations.push({
      type: CORE_MEMORY_TYPE,
      about: name,
      severity: verdict.severity,
      fires: verdict.fires,
      item: item(name, verdict.severity, list.at(-1)!),
    });
  }
  return { evaluated: [CORE_MEMORY_TYPE], observations };
}
