/**
 * Event notification adapter — wraps lib/notifications/dispatch.ts.
 *
 * Dispatches structured events to all enabled org notification channels
 * (email, webhook, slack) and publishes to the event bus for real-time
 * consumers (SSE streams, toast notifications).
 *
 * Usage:
 *   import { event } from "@/lib/messenger";
 *   event(orgId, { type: "deploy-success", title: "...", message: "...", metadata: {} });
 *
 * For typed bus events directly:
 *   import { emit } from "@/lib/messenger";
 *   emit(orgId, { type: "deploy.success", title: "...", message: "...", ... });
 */

import { notify as dispatch } from "@/lib/notifications/dispatch";
import type { NotificationEvent } from "@/lib/notifications/port";

export { emit } from "@/lib/notifications/dispatch";
export type { BusEvent, BusEventType } from "@/lib/bus";

export function event(orgId: string, evt: NotificationEvent): void {
  dispatch(orgId, evt);
}
