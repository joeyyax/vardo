// ---------------------------------------------------------------------------
// Tenant app status rows
//
// Apps whose container is not doing its job, as attention rows. Pure: the
// database read lives in ./rows.
// ---------------------------------------------------------------------------

import type { AttentionItem, AttentionRow } from "@/lib/ui/attention";

/**
 * A transition older than this is settled, not something to act on now. Apps
 * kept parked read broken forever, so an unbounded row would never clear.
 */
export const APP_DOWN_WINDOW_HOURS = 48;

/**
 * Statuses that mean the container is not doing its job, and how each reads.
 * "stopped" is absent: deriveStatus routes every broken shape to one of these,
 * so a stopped app was stopped on purpose.
 */
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
  /** Set on a compose child. Its parent is a separate subject. */
  parentAppId: string | null;
};

/**
 * Apps that broke recently enough to still be news. A null stamp means the app
 * has not transitioned since the column landed, which is what a parked app
 * looks like — it stays null because rewriting the same status leaves it alone.
 */
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

    // A stack deploy replaces every container in it, so a child reads missing
    // partway through and is not evidence of anything.
    const parent = app.parentAppId ? byId.get(app.parentAppId) : undefined;
    if (parent?.status === "deploying") continue;

    if (!app.statusChangedAt) continue;
    if (now - app.statusChangedAt.getTime() > windowMs) continue;

    items.set(app.id, {
      id: app.id,
      name: parent ? `${parent.displayName} · ${app.displayName}` : app.displayName,
      href: `/apps/${app.name}`,
      detail,
      since: app.statusChangedAt.toISOString(),
    });
  }

  // Stopping a stack writes the status to the parent and then every child.
  // One subject, not six.
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
      footer: `Each of these changed in the last ${APP_DOWN_WINDOW_HOURS} hours. One left down on purpose drops off this list on its own.`,
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
