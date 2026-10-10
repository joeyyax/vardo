import { render } from "react-email";
import type { ReactElement } from "react";
import { getEmailProviderConfig, getInstanceDisplayName, type EmailProviderConfig } from "@/lib/system-settings";
import { DEFAULT_APP_NAME } from "@/lib/app-name";
import { logger } from "@/lib/logger";
import { sendViaPouch } from "@/lib/email/pouch";

const log = logger.child("email");

type SendEmailOpts = {
  to: string;
  subject: string;
  from?: string;
  replyTo?: string;
} & (
  | { template: ReactElement; html?: never; text?: never }
  /** Pre-rendered parts. */
  | { template?: never; html: string; text: string }
);

/** `messageId` is the provider's id for the send, when it returns one. */
export type SendResult = { success: boolean; dev?: boolean; error?: string; messageId?: string };

/** What a client is told about a send. `configured` false means nothing left the server. */
export type EmailDelivery = { sent: boolean; configured: boolean; error?: string };

export function emailDelivery(result: SendResult): EmailDelivery {
  return {
    sent: result.success && !result.dev,
    configured: !result.dev,
    ...(result.error ? { error: result.error } : {}),
  };
}

/** The From display name: a custom `fromName`, else "{instance} · Vardo". */
export function fromDisplayName(fromName: string | undefined, instanceName: string | null | undefined): string {
  const custom = fromName?.trim();
  if (custom && custom !== DEFAULT_APP_NAME) return custom;
  const instance = instanceName?.trim();
  return instance && instance !== DEFAULT_APP_NAME ? `${instance} · ${DEFAULT_APP_NAME}` : DEFAULT_APP_NAME;
}

/** RFC 5322 display name, quoted when it holds specials. */
function formatFrom(name: string, address: string): string {
  const quoted = /[",.;:<>@()[\]\\]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name;
  return `${quoted} <${address}>`;
}

export async function sendEmail(opts: SendEmailOpts): Promise<SendResult> {
  const { to, subject, from, replyTo } = opts;
  const config = await getEmailProviderConfig();

  if (!config) {
    log.info(`Email provider not configured — would send to ${to}: ${subject}`);
    const preview = opts.text ?? (await render(opts.template!, { plainText: true }));
    log.info(`Preview:\n${preview.slice(0, 500)}...`);
    return { success: true, dev: true };
  }

  const html = opts.html ?? (await render(opts.template!));
  const text = opts.text ?? (await render(opts.template!, { plainText: true }));

  const instanceName = from ? null : await getInstanceDisplayName().catch(() => null);
  const fromAddress = from || formatFrom(fromDisplayName(config.fromName, instanceName), config.fromEmail || "noreply@vardo.run");
  const replyToAddress = replyTo;

  switch (config.provider) {
    case "mailpace":
      return sendViaMailpace(config, { to, subject, html, text, from: fromAddress, replyTo: replyToAddress });
    case "resend":
      return sendViaResend(config, { to, subject, html, text, from: fromAddress, replyTo: replyToAddress });
    case "postmark":
      return sendViaPostmark(config, { to, subject, html, text, from: fromAddress, replyTo: replyToAddress });
    case "pouch": {
      const result = await sendViaPouch(config, { to, subject, html, text, from: fromAddress, replyTo: replyToAddress });
      if (result.error) log.error(result.error);
      return result;
    }
    case "smtp":
      return sendViaSmtp(config, { to, subject, html, text, from: fromAddress, replyTo: replyToAddress });
    default:
      log.error(`Unknown provider: ${(config as EmailProviderConfig).provider}`);
      return { success: false, error: `Unknown email provider` };
  }
}

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
    requireTLS: port !== 465,
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
