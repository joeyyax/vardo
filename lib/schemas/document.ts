import { z } from "zod";

export const newDocumentSchema = z.object({
  projectId: z.string().min(1, "Please select a project"),
  title: z.string().min(1, "Title is required"),
});

export type NewDocumentFormData = z.infer<typeof newDocumentSchema>;
