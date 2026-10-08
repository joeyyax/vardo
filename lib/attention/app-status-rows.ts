// Tenant app status rows: apps whose container isn't doing its job. Pure; the read lives in ./rows.

import type { AttentionItem, AttentionRow } from "@/lib/ui/attention";

/** A transition older than this is settled, not something to act on now. */
export const APP_DOWN_WINDOW_HOURS = 48;

/** Broken statuses and how each reads. "stopped" gets its own neutral row. */
const STATUS_DETAIL: Record<string, string> = {
  error: "Container failed",
  missing: "No container on the host",
};

export type StatusSubject = {
  id: string;
  name: string;
  displayName: string;
  status: string;
  /** When the status last became what it is now. Null until the first transition. */
  statusChangedAt: Date | null;
  /** Declared off on purpose. */
  parked: boolean;
  /** Set on a compose child. Its parent is a separate subject. */
  parentAppId: string | null;
};

/** Apps that broke recently, plus broken ones with no stamp, shown without a duration. */
export function appStatusRows(
  apps: StatusSubject[],
  now: number,
  windowMs: number,
): AttentionRow[] {
  const byId = new Map(apps.map((a) => [a.id, a]));
  const items = new Map<string, AttentionItem>();

  for (const app of apps) {
    const detail = STATUS_DETAIL[app.status];
    if (!detail) continue;
    if (app.parked) continue;

    // A stack deploy briefly reads children as missing.
    const parent = app.parentAppId ? byId.get(app.parentAppId) : undefined;
    if (parent?.status === "deploying") continue;

    if (app.statusChangedAt && now - app.statusChangedAt.getTime() > windowMs) continue;

    items.set(app.id, {
      id: app.id,
      name: parent ? `${parent.displayName} · ${app.displayName}` : app.displayName,
      href: `/apps/${app.name}`,
      detail,
      since: app.statusChangedAt?.toISOString(),
    });
  }

  // Stopping a stack writes the parent and every child. One subject, not six.
  for (const app of apps) {
    if (app.parentAppId && items.has(app.parentAppId)) items.delete(app.id);
  }

  if (items.size === 0) return [];

  return [
    {
      key: "app-down",
      label: "App down",
      tone: "error",
      items: [...items.values()],
      footer: `Each of these broke in the last ${APP_DOWN_WINDOW_HOURS} hours, or has no record of when. Stop one to mark it down on purpose.`,
    },
  ];
}

/** Apps that aren't running. Neutral inventory, unbounded by time. */
export function appStoppedRows(apps: StatusSubject[]): AttentionRow[] {
  const byId = new Map(apps.map((a) => [a.id, a]));
  const items = new Map<string, AttentionItem>();

  for (const app of apps) {
    if (app.status !== "stopped") continue;

    const parent = app.parentAppId ? byId.get(app.parentAppId) : undefined;
    if (parent?.status === "deploying") continue;

    items.set(app.id, {
      id: app.id,
      name: parent ? `${parent.displayName} · ${app.displayName}` : app.displayName,
      href: `/apps/${app.name}`,
      since: app.statusChangedAt?.toISOString(),
    });
  }

  // One subject per stack; the parent keeps the count.
  const services = new Map<string, number>();
  for (const app of apps) {
    if (!app.parentAppId || !items.has(app.parentAppId)) continue;
    if (items.delete(app.id)) {
      services.set(app.parentAppId, (services.get(app.parentAppId) ?? 0) + 1);
    }
  }
  // Stopped reads beside the count; the row stays so a stopped stack is findable.
  for (const [id, item] of items) {
    const parts: string[] = [];
    if (byId.get(id)?.parked) parts.push("stopped");
    const count = services.get(id);
    if (count) parts.push(`${count} service${count === 1 ? "" : "s"}`);
    if (parts.length > 0) item.detail = parts.join(" · ");
  }

  if (items.size === 0) return [];

  return [
    {
      key: "app-stopped",
      label: "Stopped",
      tone: "neutral",
      items: [...items.values()],
      footer: "None of these is running. A whole stack counts once, on its parent.",
    },
  ];
}

type NamedSubject = { id: string; displayName: string; parentAppId: string | null };

/** Compose children named under their parent, so a child's row says whose it is. */
export function withParentNames<T extends NamedSubject>(apps: T[]): T[] {
  const byId = new Map(apps.map((a) => [a.id, a]));
  return apps.map((app) => {
    const parent = app.parentAppId ? byId.get(app.parentAppId) : undefined;
    return parent ? { ...app, displayName: `${parent.displayName} · ${app.displayName}` } : app;
  });
}
