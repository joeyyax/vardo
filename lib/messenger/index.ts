/**
 * Unified messaging — one import for all notification channels.
 *
 * Usage:
 *   import { toast, email, event } from "@/lib/messenger";
 *
 *   // Client (UI feedback)
 *   toast.success("Saved");
 *   toast.error("Failed", { description: "Check connection" });
 *
 *   // Server (send email)
 *   await email({ to, subject, template });
 *
 *   // Server (dispatch to org notification channels)
 *   event(orgId, { type: "deploy-success", title: "...", message: "...", metadata: {} });
 */

export { toast } from "./toast";
export { email } from "./email";
export { event } from "./event";

export type { EmailOptions } from "./email";
export type { NotificationEvent, NotificationEventType } from "@/lib/notifications/port";
