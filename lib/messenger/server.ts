/**
 * Server-side messaging - email and event dispatch.
 *
 * Usage:
 *   import { email, emit } from "@/lib/messenger/server";
 *
 *   await email({ to, subject, template });
 *   emit(orgId, { type: "deploy.success", ... });
 */

export { email } from "./email";
export { emit } from "./event";

export type { EmailOptions } from "./email";
export type { BusEvent, BusEventType } from "@/lib/bus/events";
