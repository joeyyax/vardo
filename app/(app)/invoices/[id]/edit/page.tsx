import { redirect, notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { invoices } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { InvoiceEditForm } from "./invoice-edit-form";

type RouteParams = {
  params: Promise<{ id: string }>;
};

export default async function InvoiceEditPage({ params }: RouteParams) {
  const { id } = await params;
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const invoice = await db.query.invoices.findFirst({
    where: and(
      eq(invoices.id, id),
      eq(invoices.organizationId, orgData.organization.id)
    ),
    with: {
      client: true,
      lineItems: true,
    },
  });

  if (!invoice) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <InvoiceEditForm
        invoice={{
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          periodStart: invoice.periodStart,
          periodEnd: invoice.periodEnd,
          subtotal: invoice.subtotal,
          totalMinutes: invoice.totalMinutes,
          notes: invoice.notes,
          includeTimesheet: invoice.includeTimesheet ?? false,
          client: {
            id: invoice.client.id,
            name: invoice.client.name,
            color: invoice.client.color,
          },
        }}
        lineItems={invoice.lineItems.map((item) => ({
          id: item.id,
          projectName: item.projectName,
          taskName: item.taskName,
          description: item.description,
          minutes: item.minutes,
          rate: item.rate,
          amount: item.amount,
        }))}
        orgId={orgData.organization.id}
      />
    </div>
  );
}
