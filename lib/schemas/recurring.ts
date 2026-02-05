import { z } from "zod";

export const frequencySchema = z.enum([
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
]);

export type Frequency = z.infer<typeof frequencySchema>;

export const recurringSchema = z.object({
  frequency: frequencySchema,
});

export type RecurringFormData = z.infer<typeof recurringSchema>;
