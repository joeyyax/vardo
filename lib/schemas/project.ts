import { z } from "zod";

export const projectStageSchema = z.enum([
  "lead",
  "proposal_sent",
  "active",
  "completed",
]);

export type ProjectStage = z.infer<typeof projectStageSchema>;

export const projectSchema = z.object({
  clientId: z.string().min(1, "Please select a client"),
  name: z.string().min(1, "Project name is required"),
  code: z.string(),
  rateOverride: z.string(),
  isBillable: z.boolean().nullable(),
  stage: projectStageSchema,
});

export type ProjectFormData = z.infer<typeof projectSchema>;
