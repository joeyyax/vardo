import { z } from "zod";

export const invoiceLineItemSchema = z.object({
  id: z.string(),
  projectName: z.string(),
  taskName: z.string().nullable(),
  description: z.string().nullable(),
  minutes: z.number(),
  rate: z.number(),
  amount: z.number(),
});

// Full edit form (page)
export const invoiceEditSchema = z.object({
  invoiceNumber: z.string().min(1, "Invoice number is required"),
  notes: z.string(),
  includeTimesheet: z.boolean(),
  lineItems: z.array(invoiceLineItemSchema),
});

// Dialog edit form (simpler)
export const invoiceEditDialogSchema = z.object({
  invoiceNumber: z.string().min(1, "Invoice number is required"),
  lineItems: z.array(invoiceLineItemSchema),
});

export type InvoiceLineItem = z.infer<typeof invoiceLineItemSchema>;
export type InvoiceEditFormData = z.infer<typeof invoiceEditSchema>;
export type InvoiceEditDialogFormData = z.infer<typeof invoiceEditDialogSchema>;
