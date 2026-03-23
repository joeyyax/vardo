/**
 * Email adapter — stub interface for future unification.
 *
 * The actual email sending currently lives in `lib/email/send.ts` and is used
 * by the server-side notification channels (`lib/notifications/email-channel.ts`).
 * This adapter will eventually wrap that infrastructure behind the unified
 * `notify.email()` interface.
 */

export type EmailOptions = {
  to: string | string[];
  subject: string;
  body: string;
  html?: string;
  replyTo?: string;
};

export async function email(_options: EmailOptions): Promise<void> {
  throw new Error(
    "[notify.email] Not implemented yet. Use lib/email/send.ts directly for now.",
  );
}
