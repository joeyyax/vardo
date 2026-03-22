import { render } from "@react-email/components";
import type { ReactElement } from "react";
import { getEmailProviderConfig } from "@/lib/system-settings";

const MAILPACE_API_URL = "https://app.mailpace.com/api/v1/send";

type SendEmailOpts = {
  to: string;
  subject: string;
  template: ReactElement;
  from?: string;
  replyTo?: string;
};

export async function sendEmail({ to, subject, template, from, replyTo }: SendEmailOpts) {
  // getEmailProviderConfig() returns env-var config first, then falls back to
  // the setup-wizard row in system_settings (decrypted).
  const config = await getEmailProviderConfig();

  if (!config || !config.apiKey) {
    console.log(`[email] Email provider not configured — would send to ${to}: ${subject}`);
    // In dev, render and log the HTML
    const html = await render(template);
    console.log(`[email] Preview:\n${html.slice(0, 500)}...`);
    return { success: true, dev: true };
  }

  const html = await render(template);
  const text = await render(template, { plainText: true });

  // Currently only MailPace is supported; extend this switch when SMTP/Resend
  // providers are wired up.
  const fromAddress = from || config.fromEmail || process.env.EMAIL_FROM || "Host <noreply@host.joeyyax.dev>";
  const replyToAddress = replyTo || process.env.EMAIL_REPLY_TO;

  const res = await fetch(MAILPACE_API_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "MailPace-Server-Token": config.apiKey,
    },
    body: JSON.stringify({
      from: fromAddress,
      to,
      subject,
      htmlbody: html,
      textbody: text,
      ...(replyToAddress ? { replyto: replyToAddress } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[email] MailPace error: ${res.status} ${body}`);
    return { success: false, error: body };
  }

  return { success: true };
}
