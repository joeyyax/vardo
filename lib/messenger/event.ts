/**
 * Event notification adapter — wraps lib/notifications/dispatch.ts.
 *
 * Dispatches structured events to all enabled org notification channels
 * (email, webhook, slack). This is the primary server-side notification path.
 *
 * Usage:
 *   import { event } from "@/lib/messenger";
 *   event(orgId, { type: "deploy-success", title: "...", message: "...", metadata: {} });
 */

import { notify as dispatch } from "@/lib/notifications/dispatch";
import type { NotificationEvent } from "@/lib/notifications/port";

export function event(orgId: string, evt: NotificationEvent): void {
  dispatch(orgId, evt);
}
