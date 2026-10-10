// App alerts from the health monitor's conditions.

import type { AlertItem } from "@/lib/bus/events";
import type { AppCondition } from "@/lib/docker/conditions";
import type { Observation } from "@/lib/notifications/observations";
import type { AlertType } from "@/lib/notifications/registry";
import { formatDuration } from "@/lib/email/format";

export const APP_ALERT_TYPES: AlertType[] = ["app.oom", "app.restart-loop", "app.memory-limit", "app.unhealthy"];

/** A failing health check alerts once it has failed this long. */
export const UNHEALTHY_ALERT_MS = 10 * 60_000;

export type ConditionApp = {
  id: string;
  name: string;
  organizationId: string;
  conditions: AppCondition[];
};

function sinceMs(condition: AppCondition, now: number): number {
  const t = Date.parse(condition.since);
  return Number.isNaN(t) ? now : t;
}

function observe(type: AlertType, app: ConditionApp, fires: boolean, item: Omit<AlertItem, "type" | "about" | "appId" | "appName">): Observation {
  return {
    type,
    about: app.id,
    severity: item.severity,
    fires,
    item: { type, about: app.id, appId: app.id, appName: app.name, ...item },
  };
}

/** Observations for one app's held conditions. */
export function conditionObservations(app: ConditionApp, now: number): Observation[] {
  const out: Observation[] = [];
  const kinds = new Map(app.conditions.map((c) => [c.kind, c]));

  const loop = kinds.get("self-heal-exhausted") ?? kinds.get("crash-looping");
  if (loop) {
    out.push(
      observe("app.restart-loop", app, true, {
        severity: "critical",
        title: `${app.name} keeps restarting`,
        detail:
          loop.kind === "self-heal-exhausted"
            ? "Vardo restarted it until the restart cap and stopped. It needs a look before it comes back on its own."
            : "Its container exits soon after each start. The logs usually show why.",
        facts: [{ label: "Seen", value: loop.detail }],
        since: loop.since,
      }),
    );
  }

  const memory = kinds.get("memory-pressure");
  if (memory) {
    const share = /^(\d+)%/.exec(memory.detail);
    out.push(
      observe("app.memory-limit", app, true, {
        severity: "warning",
        title: `${app.name} is near its memory limit`,
        detail: "It has stayed over 90% of its limit for 10 minutes. Raise the limit or find the leak before the kernel kills it.",
        gauge: share ? { title: "Memory limit used", percent: Number(share[1]), warn: 90, critical: 100 } : undefined,
        facts: [{ label: "Usage", value: memory.detail }],
        since: memory.since,
      }),
    );
  }

  const unhealthy = kinds.get("unhealthy");
  if (unhealthy) {
    const failing = now - sinceMs(unhealthy, now);
    out.push(
      observe("app.unhealthy", app, failing >= UNHEALTHY_ALERT_MS, {
        severity: "warning",
        title: `${app.name} is failing its health check`,
        detail: `It has failed for ${formatDuration(failing)}. Check the logs, or the health check itself if the app works.`,
        since: unhealthy.since,
      }),
    );
  }
  return out;
}
