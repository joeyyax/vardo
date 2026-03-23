/**
 * Server-side messaging — email, event dispatch, bus emit.
 *
 * Usage:
 *   import { email, event, emit } from "@/lib/messenger/server";
 *
 *   await email({ to, subject, template });
 *   event(orgId, { type: "deploy-success", ... });
 *   emit(orgId, { type: "deploy.success", ... });
 */

export { email } from "./email";
export { event, emit } from "./event";

export type { EmailOptions } from "./email";
export type { NotificationEvent, NotificationEventType } from "@/lib/notifications/port";
export type { BusEvent, BusEventType } from "@/lib/bus/events";
