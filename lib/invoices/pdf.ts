import { renderToBuffer } from "@react-pdf/renderer";
import { InvoicePdfTemplate, type InvoiceData } from "./pdf-template";
import type { invoices, invoiceLineItems, clients, organizations } from "@/lib/db/schema";

type Invoice = typeof invoices.$inferSelect;
type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
type Client = typeof clients.$inferSelect;
type Organization = typeof organizations.$inferSelect;

interface InvoiceWithRelations {
  invoice: Invoice;
  lineItems: InvoiceLineItem[];
  client: Client;
  organization: Organization;
}

/**
 * Transform database invoice data to the format expected by the PDF template.
 */
function transformToTemplateData(data: InvoiceWithRelations): InvoiceData {
  return {
    invoiceNumber: data.invoice.invoiceNumber,
    status: data.invoice.status,
    periodStart: data.invoice.periodStart,
    periodEnd: data.invoice.periodEnd,
    subtotal: data.invoice.subtotal,
    totalMinutes: data.invoice.totalMinutes,
    createdAt: data.invoice.createdAt,
    lineItems: data.lineItems.map((item) => ({
      id: item.id,
      projectName: item.projectName,
      taskName: item.taskName,
      description: item.description,
      minutes: item.minutes,
      rate: item.rate,
      amount: item.amount,
    })),
    client: {
      name: data.client.name,
    },
    organization: {
      name: data.organization.name,
    },
  };
}

/**
 * Generate a PDF buffer for an invoice.
 */
export async function generateInvoicePdf(
  data: InvoiceWithRelations
): Promise<Uint8Array> {
  const templateData = transformToTemplateData(data);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buffer = await renderToBuffer(InvoicePdfTemplate({ data: templateData }) as any);
  return buffer;
}

/**
 * Get the filename for an invoice PDF.
 */
export function getInvoicePdfFilename(invoice: Invoice, client: Client): string {
  const sanitizedClientName = client.name.replace(/[^a-zA-Z0-9]/g, "-");
  return `${invoice.invoiceNumber}-${sanitizedClientName}.pdf`;
}
