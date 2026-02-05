import { z } from "zod";

export const invoiceSchema = z.object({
  clientId: z.string().min(1, "Please select a client"),
  dateFrom: z.date({ error: "Start date is required" }),
  dateTo: z.date({ error: "End date is required" }),
  includeSummaries: z.boolean(),
});

export type InvoiceFormData = z.infer<typeof invoiceSchema>;
