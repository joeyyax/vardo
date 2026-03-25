/**
 * Email adapter — wraps lib/email/send.ts for direct email sending.
 *
 * For event-driven notifications (deploy, backup, cron failures), use
 * `notify.event()` instead — it routes through org notification channels.
 */

import { sendEmail } from "@/lib/email/send";
import type { ReactElement } from "react";

export type EmailOptions = {
  to: string;
  subject: string;
  template: ReactElement;
};

export async function email(options: EmailOptions): Promise<void> {
  await sendEmail(options);
}
