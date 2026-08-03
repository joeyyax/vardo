// ---------------------------------------------------------------------------
// Tenant app status rows
//
// Apps whose container is not doing its job, as attention rows. Pure: the
// database read lives in ./rows.
// ---------------------------------------------------------------------------

import type { AttentionItem, AttentionRow } from "@/lib/ui/attention";

/** A transition older than this is settled, not something to act on now. */
export const APP_DOWN_WINDOW_HOURS = 48;

/**
 * Statuses that mean the container is not doing its job, and how each reads.
 * "stopped" is absent: deriveStatus routes every broken shape to one of these,
 * so a stopped app was stopped on purpose. It gets its own neutral row below.
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
  /** Declared off on purpose. Nothing about being down is news on one of these. */
  parked: boolean;
  /** Set on a compose child. Its parent is a separate subject. */
  parentAppId: string | null;
};

/**
 * Apps that broke recently enough to still be news, plus any that are broken
 * with no stamp to date it. A null stamp is not evidence of anything — the app
 * has just not transitioned since the column landed — so it earns the row
 * without a duration rather than being dropped from it.
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
    if (app.parked) continue;

    // A stack deploy replaces every container in it, so a child reads missing
    // partway through and is not evidence of anything.
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
      footer: `Each of these broke in the last ${APP_DOWN_WINDOW_HOURS} hours, or has no record of when. Park one to say it is down on purpose and drop it off this list.`,
    },
  ];
}

/**
 * Apps that are not running. Neutral, and deliberately unbounded by time: this
 * is an inventory rather than an alert, and a stack shelved in March is exactly
 * the one that would otherwise be impossible to find from the board.
 */
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

  // stopApp writes stopped to the parent and then every child. One subject, not
  // six — the parent keeps the count of what came down with it.
  const services = new Map<string, number>();
  for (const app of apps) {
    if (!app.parentAppId || !items.has(app.parentAppId)) continue;
    if (items.delete(app.id)) {
      services.set(app.parentAppId, (services.get(app.parentAppId) ?? 0) + 1);
    }
  }
  // Parked reads beside the count rather than removing the row: the inventory
  // is how a shelved stack stays findable, and saying why it is quiet is the
  // whole point of the flag.
  for (const [id, item] of items) {
    const parts: string[] = [];
    if (byId.get(id)?.parked) parts.push("parked");
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
