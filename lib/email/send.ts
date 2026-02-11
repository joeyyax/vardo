import { render } from "@react-email/components";
import type { ReactElement } from "react";

type SendEmailParams = {
  to: string | string[];
  subject: string;
  react: ReactElement;
  from?: string;
  replyTo?: string;
};

/**
 * Check if email sending is configured (Resend API key present).
 */
export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

/**
 * Send an email via Resend.
 * Returns true on success, false if email is not configured or sending fails.
 * Errors are logged but not thrown — email should never block business logic.
 */
export async function sendEmail(params: SendEmailParams): Promise<boolean> {
  if (!isEmailConfigured()) {
    console.warn("Email not configured — skipping send");
    return false;
  }

  try {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);

    const html = await render(params.react);

    const fromAddress =
      params.from || process.env.EMAIL_FROM || "notifications@joeyyax.com";

    await resend.emails.send({
      from: fromAddress,
      to: Array.isArray(params.to) ? params.to : [params.to],
      subject: params.subject,
      html,
      replyTo: params.replyTo,
    });

    return true;
  } catch (error) {
    console.error("Error sending email:", error);
    return false;
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
