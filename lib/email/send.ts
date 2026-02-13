import { render } from "@react-email/components";
import type { ReactElement } from "react";
import type { EmailSendEntityType } from "@/lib/db/schema";

type SendEmailParams = {
  to: string | string[];
  subject: string;
  react: ReactElement;
  from?: string;
  replyTo?: string;
};

type EmailContext = {
  organizationId: string;
  entityType: EmailSendEntityType;
  entityId: string;
};

type SendEmailResult = {
  success: boolean;
  emailId?: string;
};

/**
 * Check if email sending is configured (MailPace API token present).
 */
export function isEmailConfigured(): boolean {
  return !!process.env.MAILPACE_API_TOKEN;
}

/**
 * Send an email via MailPace.
 * Returns { success, emailId } — emailId is the MailPace message ID on success.
 * When context is provided, the send is logged to email_sends for delivery tracking.
 * Errors are logged but not thrown — email should never block business logic.
 */
export async function sendEmail(
  params: SendEmailParams,
  context?: EmailContext
): Promise<SendEmailResult> {
  if (!isEmailConfigured()) {
    console.warn("Email not configured — skipping send");
    return { success: false };
  }

  try {
    const html = await render(params.react);

    const fromAddress =
      params.from || process.env.EMAIL_FROM || "Scope <noreply@usescope.net>";

    const recipients = Array.isArray(params.to) ? params.to : [params.to];

    const response = await fetch("https://app.mailpace.com/api/v1/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "MailPace-Server-Token": process.env.MAILPACE_API_TOKEN!,
      },
      body: JSON.stringify({
        from: fromAddress,
        to: recipients.join(", "),
        subject: params.subject,
        htmlbody: html,
        ...(params.replyTo ? { replyto: params.replyTo } : {}),
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("MailPace send error:", response.status, errorBody);
      return { success: false };
    }

    const result = await response.json();
    const emailId = result.id ? String(result.id) : undefined;

    // Log to email_sends when context is provided
    if (context && emailId) {
      try {
        const { db } = await import("@/lib/db");
        const { emailSends } = await import("@/lib/db/schema");

        for (const recipient of recipients) {
          await db.insert(emailSends).values({
            organizationId: context.organizationId,
            externalEmailId: recipients.length === 1
              ? emailId
              : `${emailId}:${recipient}`,
            entityType: context.entityType,
            entityId: context.entityId,
            recipientEmail: recipient,
            subject: params.subject,
            status: "sent",
          });
        }
      } catch (logError) {
        // Don't let logging failures affect send result
        console.error("Error logging email send:", logError);
      }
    }

    return { success: true, emailId };
  } catch (error) {
    console.error("Error sending email:", error);
    return { success: false };
  }
}

/**
 * Get client-facing email recipients for a project.
 * Pulls from project invitations (accepted or pending).
 */
export async function getProjectRecipients(
  projectId: string
): Promise<string[]> {
  const { db } = await import("@/lib/db");
  const { projectInvitations } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");

  const invitations = await db.query.projectInvitations.findMany({
    where: eq(projectInvitations.projectId, projectId),
    columns: { email: true },
  });

  return invitations.map((inv) => inv.email);
}
