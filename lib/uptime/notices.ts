// Sends uptime notices. Incidents open and resolve at once; the notification waits a minute so a burst goes out as one.

import { emit } from "@/lib/notifications/dispatch";
import { getInstanceDisplayName } from "@/lib/system-settings";
import { describeGroup, dueGroups, type Notice } from "./core";

let pending: Notice[] = [];

export function queueNotice(notice: Notice): void {
  pending.push(notice);
}

/** What's waiting, for tests. */
export const pendingNotices = (): readonly Notice[] => pending;
export const clearNotices = (): void => {
  pending = [];
};

/** Sends each group that has waited its minute: one notification per audience and kind. */
export async function flushNotices(now = Date.now()): Promise<number> {
  const { due, rest } = dueGroups(pending, now);
  pending = rest;
  if (due.length === 0) return 0;
  const instance = (await getInstanceDisplayName().catch(() => null)) || "Vardo";
  for (const group of due) {
    const { subject, title, message } = describeGroup(instance, group);
    const orgIds = group[0].audience.split(",").filter(Boolean);
    for (const orgId of orgIds) {
      if (group[0].kind === "recovered") {
        const at = new Date(now).toISOString();
        emit(orgId, {
          type: "alert.resolved",
          title: `Resolved: ${title}`,
          message,
          alerts: group.map((n) => ({
            type: "uptime.down",
            about: n.monitorId,
            severity: "critical" as const,
            title: n.title,
            detail: n.detail,
            firedAt: at,
            resolvedAt: at,
          })),
        });
      } else {
        emit(orgId, { type: "system.service-down", title, message, service: group.length === 1 ? group[0].name : (group[0].instance ?? instance), description: title, subject });
      }
    }
  }
  return due.length;
}
