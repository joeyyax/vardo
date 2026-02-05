import { z } from "zod";

export const clientSchema = z.object({
  name: z.string().min(1, "Name is required"),
  color: z.string().nullable(),
  rateOverride: z.string(),
  isBillable: z.boolean().nullable(),
  parentClientId: z.string().nullable(),
  // Billing configuration
  billingType: z.string().nullable(),
  billingFrequency: z.string().nullable(),
  autoGenerateInvoices: z.boolean(),
  retainerAmount: z.string(),
  billingDayOfWeek: z.number().nullable(),
  billingDayOfMonth: z.number().nullable(),
  paymentTermsDays: z.string(),
});

export type ClientFormData = z.infer<typeof clientSchema>;
