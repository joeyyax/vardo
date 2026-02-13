import { NextRequest, NextResponse } from "next/server";
import { render } from "@react-email/components";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import {
  getInvoiceWithLineItems,
  generateInvoicePdf,
  getInvoicePdfFilename,
  markInvoiceSent,
} from "@/lib/invoices";
import { InvoiceEmail } from "@/lib/email/templates/invoice";
import { createCheckoutSession, isStripeConfigured } from "@/lib/payments/stripe";
import { db } from "@/lib/db";
import { invoices } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; invoiceId: string }>;
};

// POST /api/v1/organizations/[orgId]/invoices/[invoiceId]/send
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const body = await request.json();
    const { email, subject, message } = body;

    // Validate required fields
    if (!email) {
      return NextResponse.json(
        { error: "Recipient email is required" },
        { status: 400 }
      );
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: "Invalid email address" },
        { status: 400 }
      );
    }

    // Check if MailPace is configured
    if (!process.env.MAILPACE_API_TOKEN) {
      return NextResponse.json(
        { error: "Email sending is not configured" },
        { status: 503 }
      );
    }

    // Get invoice with all related data
    const data = await getInvoiceWithLineItems(invoiceId, orgId);

    if (!data) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    // Generate PDF
    const pdfBuffer = await generateInvoicePdf(data);
    const filename = getInvoicePdfFilename(data.invoice, data.client);

    // Build public view URL
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const publicUrl = `${baseUrl}/invoices/${data.invoice.publicToken}`;

    // Create Stripe Checkout session if Stripe is configured
    let paymentUrl: string | undefined;
    if (isStripeConfigured() && data.invoice.subtotal > 0) {
      const session = await createCheckoutSession({
        invoiceId,
        invoiceNumber: data.invoice.invoiceNumber,
        amountCents: data.invoice.subtotal,
        clientName: data.client.name,
        clientEmail: email,
        successUrl: `${publicUrl}?payment=success`,
        cancelUrl: publicUrl,
      });

      if (session) {
        paymentUrl = session.url;
        // Store payment URL and session ID on the invoice
        await db
          .update(invoices)
          .set({
            paymentUrl: session.url,
            stripeCheckoutSessionId: session.sessionId,
          })
          .where(eq(invoices.id, invoiceId));
      }
    }

    // Build email subject
    const defaultSubject = `Invoice ${data.invoice.invoiceNumber} from ${data.organization.name}`;
    const emailSubject = subject || defaultSubject;

    // Render email using React Email template
    const emailHtml = await render(
      InvoiceEmail({
        invoiceNumber: data.invoice.invoiceNumber,
        organizationName: data.organization.name,
        clientName: data.client.name,
        periodStart: data.invoice.periodStart,
        periodEnd: data.invoice.periodEnd,
        totalMinutes: data.invoice.totalMinutes,
        subtotal: data.invoice.subtotal,
        publicUrl,
        paymentUrl,
        message,
      })
    );

    // Send email via MailPace (uses direct API for attachments — not sendEmail wrapper)
    // MailPace filenames can't have more than one period — sanitize
    const safeFilename = filename.replace(/\.(?=.*\.)/g, "_");

    const sendResponse = await fetch("https://app.mailpace.com/api/v1/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "MailPace-Server-Token": process.env.MAILPACE_API_TOKEN!,
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || `${data.organization.name} <noreply@usescope.net>`,
        to: email,
        subject: emailSubject,
        htmlbody: emailHtml,
        attachments: [
          {
            name: safeFilename,
            content: Buffer.from(pdfBuffer).toString("base64"),
            content_type: "application/pdf",
          },
        ],
      }),
    });

    if (!sendResponse.ok) {
      const errorBody = await sendResponse.text();
      console.error("MailPace send error:", sendResponse.status, errorBody);
      return NextResponse.json(
        { error: "Failed to send email" },
        { status: 502 }
      );
    }

    const sendResult = await sendResponse.json();

    // Log to email_sends for delivery tracking
    const externalEmailId = sendResult.id ? String(sendResult.id) : null;
    if (externalEmailId) {
      try {
        const { emailSends } = await import("@/lib/db/schema");
        await db.insert(emailSends).values({
          organizationId: orgId,
          externalEmailId,
          entityType: "invoice",
          entityId: invoiceId,
          recipientEmail: email,
          subject: emailSubject,
          status: "sent",
        });
      } catch (logError) {
        console.error("Error logging invoice email send:", logError);
      }
    }

    // Mark invoice as sent
    await markInvoiceSent(invoiceId);

    return NextResponse.json({
      success: true,
      sentTo: email,
      invoiceNumber: data.invoice.invoiceNumber,
      paymentUrl,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error sending invoice:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
