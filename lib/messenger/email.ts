// Direct email sending. Event notifications go through emit, which routes to org channels.

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
