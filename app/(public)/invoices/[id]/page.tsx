import { notFound } from "next/navigation";
import { getInvoiceByToken, markInvoiceViewed } from "@/lib/invoices/generate";
import { formatCurrency, formatHoursDecimal } from "@/lib/formatting";
import { PrintButton } from "./print-button";
import { PayNowButton } from "./pay-now-button";

type RouteParams = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ payment?: string }>;
};

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default async function PublicInvoicePage({ params, searchParams }: RouteParams) {
  const { id: token } = await params;
  const { payment } = await searchParams;

  const data = await getInvoiceByToken(token);

  if (!data) {
    notFound();
  }

  const { invoice, lineItems, client, organization } = data;

  // Mark as viewed (non-blocking)
  markInvoiceViewed(invoice.id).catch(console.error);

  const isPaid = invoice.status === "paid";
  const paymentSuccess = payment === "success";
  const showPayButton = !isPaid && !paymentSuccess && !!invoice.paymentUrl;

  return (
    <div className="min-h-screen bg-gray-50 py-8 print:bg-white print:py-0">
      <div className="mx-auto max-w-3xl px-4 print:max-w-none print:px-0">
        <div className="rounded-lg bg-white shadow-sm print:shadow-none">
          {/* Header */}
          <div className="border-b p-8 print:border-0">
            <div className="flex justify-between">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">Invoice</h1>
                <p className="mt-1 text-lg text-gray-600">{organization.name}</p>
              </div>
              <div className="text-right">
                <p className="text-lg font-medium text-gray-900">
                  {invoice.invoiceNumber}
                </p>
                <p className="text-sm text-gray-500">
                  {formatDate(invoice.createdAt.toISOString().split("T")[0])}
                </p>
              </div>
            </div>
          </div>

          {/* Meta */}
          <div className="grid grid-cols-2 gap-8 border-b p-8 print:border-0">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                Bill To
              </p>
              <p className="mt-2 text-lg font-medium text-gray-900">
                {client.name}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                Period
              </p>
              <p className="mt-2 text-gray-900">
                {formatDate(invoice.periodStart)} - {formatDate(invoice.periodEnd)}
              </p>
            </div>
          </div>

          {/* Line items */}
          <div className="p-8">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                  <th className="pb-3">Description</th>
                  <th className="pb-3 text-right">Hours</th>
                  <th className="pb-3 text-right">Rate</th>
                  <th className="pb-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {lineItems.map((item) => (
                  <tr key={item.id}>
                    <td className="py-4">
                      <p className="font-medium text-gray-900">
                        {item.projectName}
                      </p>
                      {item.taskName && (
                        <p className="text-sm text-gray-500">{item.taskName}</p>
                      )}
                      {item.description && (
                        <p className="mt-1 text-sm text-gray-500">
                          {item.description}
                        </p>
                      )}
                    </td>
                    <td className="py-4 text-right tabular-nums text-gray-600">
                      {formatHoursDecimal(item.minutes)}
                    </td>
                    <td className="py-4 text-right tabular-nums text-gray-600">
                      {formatCurrency(item.rate)}/hr
                    </td>
                    <td className="py-4 text-right tabular-nums font-medium text-gray-900">
                      {formatCurrency(item.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="border-t p-8">
            <div className="flex justify-end">
              <div className="w-64 space-y-3">
                <div className="flex justify-between text-gray-600">
                  <span>Total Hours</span>
                  <span className="tabular-nums">
                    {formatHoursDecimal(invoice.totalMinutes)}
                  </span>
                </div>
                <div className="flex justify-between border-t pt-3 text-xl font-bold text-gray-900">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {formatCurrency(invoice.subtotal)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="border-t p-8 text-center text-sm text-gray-500 print:hidden">
            {isPaid || paymentSuccess ? (
              <p className="text-green-600 font-medium">
                {paymentSuccess ? "Payment received — thank you!" : "This invoice has been paid."}
              </p>
            ) : (
              <p>Thank you for your business</p>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="mt-6 flex justify-center gap-4 print:hidden">
          {showPayButton && (
            <PayNowButton
              paymentUrl={invoice.paymentUrl!}
              amount={formatCurrency(invoice.subtotal)}
            />
          )}
          <PrintButton />
        </div>
      </div>
    </div>
  );
}
