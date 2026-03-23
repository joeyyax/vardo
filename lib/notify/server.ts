/**
 * Server-side notification adapter.
 *
 * Usage:
 *   import { notify } from "@/lib/notify/server";
 *   notify.event(orgId, { type: "deploy-success", ... });
 *   notify.email({ to, subject, template });
 */

import { event } from "./event";
import { email } from "./email";

export const notify = {
  event,
  email,
} as const;

export type { EmailOptions } from "./email";
export type { NotificationEvent, NotificationEventType } from "@/lib/notifications/port";
