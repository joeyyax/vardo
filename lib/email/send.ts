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
 * Check if email sending is configured (Resend API key present).
 */
export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

/**
 * Send an email via Resend.
 * Returns { success, emailId } — emailId is the Resend message ID on success.
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
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);

    const html = await render(params.react);

    const fromAddress =
      params.from || process.env.EMAIL_FROM || "notifications@joeyyax.com";

    const response = await resend.emails.send({
      from: fromAddress,
      to: Array.isArray(params.to) ? params.to : [params.to],
      subject: params.subject,
      html,
      replyTo: params.replyTo,
    });

    const emailId = response.data?.id;

    // Log to email_sends when context is provided
    if (context && emailId) {
      try {
        const { db } = await import("@/lib/db");
        const { emailSends } = await import("@/lib/db/schema");

        const recipients = Array.isArray(params.to) ? params.to : [params.to];
        for (const recipient of recipients) {
          await db.insert(emailSends).values({
            organizationId: context.organizationId,
            resendEmailId: recipients.length === 1
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

    return { success: true, emailId: emailId ?? undefined };
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
