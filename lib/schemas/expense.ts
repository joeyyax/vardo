import { z } from "zod";

export const expenseSchema = z.object({
  description: z.string().min(1, "Description is required"),
  amount: z.string().min(1, "Amount is required"),
  date: z.string(),
  category: z.string(),
  projectId: z.string(),
  isBillable: z.boolean(),
  isRecurring: z.boolean(),
  recurringFrequency: z.string(),
  vendor: z.string().optional(),
  status: z.enum(["paid", "unpaid"]),
});

export type ExpenseFormData = z.infer<typeof expenseSchema>;
