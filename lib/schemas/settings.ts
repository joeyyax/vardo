import { z } from "zod";

export const organizationSettingsSchema = z.object({
  name: z.string().min(1, "Organization name is required"),
  defaultRate: z
    .string()
    .transform((val) => (val ? Math.round(parseFloat(val) * 100) : null)),
  roundingIncrement: z.string().transform((val) => parseInt(val, 10)),
});

export type OrganizationSettingsFormData = z.infer<
  typeof organizationSettingsSchema
>;

export const featuresSchema = z.object({
  time_tracking: z.boolean(),
  invoicing: z.boolean(),
  pm: z.boolean(),
  proposals: z.boolean(),
});

export type FeaturesFormData = z.infer<typeof featuresSchema>;
