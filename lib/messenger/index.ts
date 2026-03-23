/**
 * Unified messaging — one import for all notification channels.
 *
 * Usage:
 *   import { toast, email, event, emit } from "@/lib/messenger";
 *
 *   // Client (UI feedback)
 *   toast.success("Saved");
 *   toast.error("Failed", { description: "Check connection" });
 *
 *   // Server (send email)
 *   await email({ to, subject, template });
 *
 *   // Server (dispatch to org notification channels — legacy format)
 *   event(orgId, { type: "deploy-success", title: "...", message: "...", metadata: {} });
 *
 *   // Server (emit typed bus event — new format)
 *   emit(orgId, { type: "deploy.success", title: "...", message: "...", projectName: "...", ... });
 */

export { toast } from "./toast";
export { email } from "./email";
export { event, emit } from "./event";

export type { EmailOptions } from "./email";
export type { NotificationEvent, NotificationEventType } from "@/lib/notifications/port";
export type { BusEvent, BusEventType } from "./event";
