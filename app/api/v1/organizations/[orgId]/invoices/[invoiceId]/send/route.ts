import { NextRequest, NextResponse } from "next/server";
import { render } from "@react-email/components";
import { requireOrg } from "@/lib/auth/session";
import {
  getInvoiceWithLineItems,
  generateInvoicePdf,
  getInvoicePdfFilename,
  markInvoiceSent,
} from "@/lib/invoices";
import { InvoiceEmail } from "@/lib/email/templates/invoice";

type RouteParams = {
  params: Promise<{ orgId: string; invoiceId: string }>;
};

// POST /api/v1/organizations/[orgId]/invoices/[invoiceId]/send
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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

    // Check if Resend is configured
    if (!process.env.RESEND_API_KEY) {
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
        message,
      })
    );

    // Send email via Resend
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);

    await resend.emails.send({
      from: `${data.organization.name} <joey@joeyyax.com>`,
      to: email,
      subject: emailSubject,
      html: emailHtml,
      attachments: [
        {
          filename,
          content: Buffer.from(pdfBuffer).toString("base64"),
        },
      ],
    });

    // Mark invoice as sent
    await markInvoiceSent(invoiceId);

    return NextResponse.json({
      success: true,
      sentTo: email,
      invoiceNumber: data.invoice.invoiceNumber,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
