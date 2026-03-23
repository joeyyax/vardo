/**
 * Server-side notification adapter.
 *
 * Usage:
 *   import { serverNotify } from "@/lib/notify/server";
 *   serverNotify.event(orgId, { type: "deploy-success", ... });
 *   serverNotify.email({ to, subject, template });
 */

import { event } from "./event";
import { email } from "./email";

export const serverNotify = {
  event,
  email,
} as const;

export type { EmailOptions } from "./email";
export type { NotificationEvent, NotificationEventType } from "@/lib/notifications/port";
