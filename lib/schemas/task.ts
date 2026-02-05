import { z } from "zod";

export const taskStatusSchema = z.enum(["todo", "in_progress", "review", "done"]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string(),
  rateOverride: z.string(),
  isBillable: z.boolean().nullable(),
  status: taskStatusSchema.nullable(),
  typeId: z.string().nullable(),
  estimateHours: z.string(),
  prLink: z.string(),
  isClientVisible: z.boolean(),
});

export type TaskFormData = z.infer<typeof taskSchema>;
