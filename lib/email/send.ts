import { render } from "@react-email/components";
import type { ReactElement } from "react";

const MAILPACE_API_URL = "https://app.mailpace.com/api/v1/send";

type SendEmailOpts = {
  to: string;
  subject: string;
  template: ReactElement;
  from?: string;
  replyTo?: string;
};

export async function sendEmail({ to, subject, template, from, replyTo }: SendEmailOpts) {
  const token = process.env.MAILPACE_API_TOKEN;
  if (!token) {
    console.log(`[email] No MAILPACE_API_TOKEN — would send to ${to}: ${subject}`);
    // In dev, render and log the HTML
    const html = await render(template);
    console.log(`[email] Preview:\n${html.slice(0, 500)}...`);
    return { success: true, dev: true };
  }

  const html = await render(template);
  const text = await render(template, { plainText: true });

  const res = await fetch(MAILPACE_API_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "MailPace-Server-Token": token,
    },
    body: JSON.stringify({
      from: from || process.env.EMAIL_FROM || "Host <noreply@host.joeyyax.dev>",
      to,
      subject,
      htmlbody: html,
      textbody: text,
      ...(replyTo || process.env.EMAIL_REPLY_TO
        ? { replyto: replyTo || process.env.EMAIL_REPLY_TO }
        : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[email] MailPace error: ${res.status} ${body}`);
    return { success: false, error: body };
  }

  return { success: true };
}
