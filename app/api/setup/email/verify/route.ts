import { NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getEmailProviderConfig } from "@/lib/system-settings";
import nodemailer from "nodemailer";

export async function POST() {
  try {
    await requireAdminAuth();
  } catch {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const config = await getEmailProviderConfig();
  if (!config) {
    return NextResponse.json({
      ok: false,
      message: "Email is not configured — save your settings first",
    });
  }

  try {
    switch (config.provider) {
      case "resend": {
        if (!config.apiKey) {
          return NextResponse.json({ ok: false, message: "Resend API key is missing" });
        }
        const res = await fetch("https://api.resend.com/domains", {
          headers: { Authorization: `Bearer ${config.apiKey}` },
        });
        if (!res.ok) {
          return NextResponse.json({
            ok: false,
            message: `Resend returned ${res.status} — check your API key`,
          });
        }
        return NextResponse.json({ ok: true, message: "Resend API key is valid" });
      }

      case "postmark": {
        if (!config.apiKey) {
          return NextResponse.json({ ok: false, message: "Postmark server token is missing" });
        }
        const res = await fetch("https://api.postmarkapp.com/server", {
          headers: {
            Accept: "application/json",
            "X-Postmark-Server-Token": config.apiKey,
          },
        });
        if (!res.ok) {
          return NextResponse.json({
            ok: false,
            message: `Postmark returned ${res.status} — check your server token`,
          });
        }
        const server = (await res.json()) as { Name?: string };
        return NextResponse.json({
          ok: true,
          message: `Connected to Postmark server "${server.Name ?? "unknown"}"`,
        });
      }

      case "mailpace": {
        if (!config.apiKey) {
          return NextResponse.json({ ok: false, message: "Mailpace API token is missing" });
        }
        const res = await fetch("https://app.mailpace.com/api/v1/domain_verifications", {
          headers: {
            Accept: "application/json",
            "MailPace-Server-Token": config.apiKey,
          },
        });
        if (!res.ok) {
          return NextResponse.json({
            ok: false,
            message: `Mailpace returned ${res.status} — check your API token`,
          });
        }
        return NextResponse.json({ ok: true, message: "Mailpace API token is valid" });
      }

      case "smtp": {
        if (!config.smtpHost) {
          return NextResponse.json({ ok: false, message: "SMTP host is not set" });
        }
        const transport = nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort ?? 587,
          auth: config.smtpUser
            ? { user: config.smtpUser, pass: config.smtpPass ?? "" }
            : undefined,
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
        });

        await transport.verify();
        transport.close();
        return NextResponse.json({
          ok: true,
          message: `SMTP connection to ${config.smtpHost}:${config.smtpPort ?? 587} succeeded`,
        });
      }

      default:
        return NextResponse.json({
          ok: false,
          message: `Unknown provider: ${config.provider}`,
        });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, message: `Verification failed: ${msg}` });
  }
}
