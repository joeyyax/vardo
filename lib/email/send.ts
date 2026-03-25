import { render } from "@react-email/components";
import type { ReactElement } from "react";
import { getEmailProviderConfig, type EmailProviderConfig } from "@/lib/system-settings";
import { logger } from "@/lib/logger";

const log = logger.child("email");

type SendEmailOpts = {
  to: string;
  subject: string;
  template: ReactElement;
  from?: string;
  replyTo?: string;
};

type SendResult = { success: boolean; dev?: boolean; error?: string };

export async function sendEmail({ to, subject, template, from, replyTo }: SendEmailOpts): Promise<SendResult> {
  const config = await getEmailProviderConfig();

  if (!config) {
    log.info(`Email provider not configured — would send to ${to}: ${subject}`);
    const html = await render(template);
    log.info(`Preview:\n${html.slice(0, 500)}...`);
    return { success: true, dev: true };
  }

  const html = await render(template);
  const text = await render(template, { plainText: true });

  const fromAddress = from || (config.fromName && config.fromEmail
    ? `${config.fromName} <${config.fromEmail}>`
    : config.fromEmail || "Vardo <noreply@vardo.run>");
  const replyToAddress = replyTo || config.replyTo;

  switch (config.provider) {
    case "mailpace":
      return sendViaMailpace(config, { to, subject, html, text, from: fromAddress, replyTo: replyToAddress });
    case "resend":
      return sendViaResend(config, { to, subject, html, text, from: fromAddress, replyTo: replyToAddress });
    case "postmark":
      return sendViaPostmark(config, { to, subject, html, text, from: fromAddress, replyTo: replyToAddress });
    case "smtp":
      return sendViaSmtp(config, { to, subject, html, text, from: fromAddress, replyTo: replyToAddress });
    default:
      log.error(`Unknown provider: ${(config as EmailProviderConfig).provider}`);
      return { success: false, error: `Unknown email provider` };
  }
}

// ---------------------------------------------------------------------------
// Mailpace
// ---------------------------------------------------------------------------

async function sendViaMailpace(
  config: EmailProviderConfig,
  msg: { to: string; subject: string; html: string; text: string; from: string; replyTo?: string },
): Promise<SendResult> {
  if (!config.apiKey) return { success: false, error: "Mailpace API token not configured" };

  const res = await fetch("https://app.mailpace.com/api/v1/send", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "MailPace-Server-Token": config.apiKey,
    },
    body: JSON.stringify({
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      htmlbody: msg.html,
      textbody: msg.text,
      ...(msg.replyTo ? { replyto: msg.replyTo } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    log.error(`Mailpace error: ${res.status} ${body.slice(0, 200)}`);
    return { success: false, error: `Mailpace: ${res.status}` };
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

async function sendViaResend(
  config: EmailProviderConfig,
  msg: { to: string; subject: string; html: string; text: string; from: string; replyTo?: string },
): Promise<SendResult> {
  if (!config.apiKey) return { success: false, error: "Resend API key not configured" };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: msg.from,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      ...(msg.replyTo ? { reply_to: [msg.replyTo] } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    log.error(`Resend error: ${res.status} ${body.slice(0, 200)}`);
    return { success: false, error: `Resend: ${res.status}` };
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// Postmark
// ---------------------------------------------------------------------------

async function sendViaPostmark(
  config: EmailProviderConfig,
  msg: { to: string; subject: string; html: string; text: string; from: string; replyTo?: string },
): Promise<SendResult> {
  if (!config.apiKey) return { success: false, error: "Postmark server token not configured" };

  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": config.apiKey,
    },
    body: JSON.stringify({
      From: msg.from,
      To: msg.to,
      Subject: msg.subject,
      HtmlBody: msg.html,
      TextBody: msg.text,
      ...(msg.replyTo ? { ReplyTo: msg.replyTo } : {}),
      MessageStream: "outbound",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    log.error(`Postmark error: ${res.status} ${body.slice(0, 200)}`);
    return { success: false, error: `Postmark: ${res.status}` };
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// SMTP (via nodemailer)
// ---------------------------------------------------------------------------

async function sendViaSmtp(
  config: EmailProviderConfig,
  msg: { to: string; subject: string; html: string; text: string; from: string; replyTo?: string },
): Promise<SendResult> {
  if (!config.smtpHost) return { success: false, error: "SMTP host not configured" };

  const nodemailerModule = await import("nodemailer");
  const nodemailer = nodemailerModule.default ?? nodemailerModule;

  const port = config.smtpPort || 587;
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port,
    secure: port === 465,
    requireTLS: port !== 465, // Enforce STARTTLS on non-implicit-TLS ports
    auth: config.smtpUser
      ? { user: config.smtpUser, pass: config.smtpPass }
      : undefined,
  });

  try {
    await transport.sendMail({
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "SMTP send failed";
    log.error(`SMTP error: ${message}`);
    return { success: false, error: message };
  }
}
