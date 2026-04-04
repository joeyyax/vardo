/**
 * Event notification adapter - wraps lib/notifications/dispatch.ts.
 *
 * Dispatches structured bus events to all enabled org notification channels
 * (email, webhook, slack) and publishes to the event bus for real-time
 * consumers (SSE streams, toast notifications).
 *
 * Usage:
 *   import { emit } from "@/lib/messenger/server";
 *   emit(orgId, { type: "deploy.success", title: "...", message: "...", ... });
 */

export { emit } from "@/lib/notifications/dispatch";
export type { BusEvent, BusEventType } from "@/lib/bus";
