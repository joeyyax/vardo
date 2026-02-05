import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth/session";
import { getInvoiceWithLineItems, generateInvoicePdf, getInvoicePdfFilename } from "@/lib/invoices";

type RouteParams = {
  params: Promise<{ orgId: string; invoiceId: string }>;
};

// GET /api/v1/organizations/[orgId]/invoices/[invoiceId]/pdf
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Get invoice with all related data
    const data = await getInvoiceWithLineItems(invoiceId, orgId);

    if (!data) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    // Generate PDF
    const pdfBuffer = await generateInvoicePdf(data);
    const filename = getInvoicePdfFilename(data.invoice, data.client);

    // Return PDF as response
    return new NextResponse(Buffer.from(pdfBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": pdfBuffer.byteLength.toString(),
      },
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
    console.error("Error generating PDF:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
