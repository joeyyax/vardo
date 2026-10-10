// Recent OOM kills per app, fed by every `app.oom-killed` emit in this process.

import { onEmit } from "@/lib/bus";

/** A kill holds its app's alert this long after the last one. */
export const OOM_HOLD_MS = 60 * 60_000;

export type OomRecord = {
  organizationId: string;
  appId: string;
  appName: string;
  containers: Map<string, number>;
  kills: number;
  hostKill: boolean;
  firstAt: number;
  lastAt: number;
};

const recent = new Map<string, OomRecord>();

export function recordOomKill(
  organizationId: string,
  kill: { appId: string; appName: string; containerName: string; kind: "oom-host" | "oom-limit" },
  at: number,
): void {
  const key = `${organizationId}:${kill.appId}`;
  const record = recent.get(key) ?? {
    organizationId,
    appId: kill.appId,
    appName: kill.appName,
    containers: new Map(),
    kills: 0,
    hostKill: false,
    firstAt: at,
    lastAt: at,
  };
  record.containers.set(kill.containerName, (record.containers.get(kill.containerName) ?? 0) + 1);
  record.kills += 1;
  record.hostKill ||= kill.kind === "oom-host";
  record.lastAt = Math.max(record.lastAt, at);
  recent.set(key, record);
}

/** Kills inside the hold window. Older records are dropped. */
export function recentOomKills(now: number): OomRecord[] {
  for (const [key, record] of recent) {
    if (now - record.lastAt > OOM_HOLD_MS) recent.delete(key);
  }
  return [...recent.values()];
}

export function resetOomKills(): void {
  recent.clear();
}

onEmit("alerts-oom", (organizationId, event) => {
  if (event.type !== "app.oom-killed" || !event.appId) return;
  recordOomKill(organizationId, event, Date.now());
});
