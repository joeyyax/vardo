import { z } from "zod";

/** Request body accepted by POST /api/v1/organizations/[orgId]/apps. */
export const createAppSchema = z
  .object({
    displayName: z.string().min(1, "Display name is required"),
    name: z
      .string()
      .min(1, "Name is required")
      .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with hyphens"),
    description: z.string().optional(),
    source: z.enum(["git", "direct"]),
    deployType: z.enum(["compose", "dockerfile", "image", "static", "nixpacks", "railpack"]),
    gitUrl: z.string().url().refine((url) => url.startsWith("https://"), { message: "Only HTTPS git URLs are allowed" }).optional(),
    gitBranch: z.string().regex(/^[a-zA-Z0-9._\-/]+$/, "Invalid branch name").optional(),
    imageName: z.string().optional(),
    composeContent: z.string().max(512000).optional(),
    composeFilePath: z.string().regex(/^[a-zA-Z0-9._-][a-zA-Z0-9._\-/]*$/, "Invalid file path").optional(),
    dockerfilePath: z.string().regex(/^[a-zA-Z0-9._-][a-zA-Z0-9._\-/]*$/, "Invalid file path").optional(),
    rootDirectory: z.string().optional(),
    templateName: z.string().max(100).optional(),
    containerPort: z.number().int().positive().optional(),
    autoTraefikLabels: z.boolean().default(false),
    autoDeploy: z.boolean().default(false),
    generateDomain: z.boolean().default(true),
    persistentVolumes: z.array(z.object({
      name: z.string(),
      mountPath: z.string(),
    })).optional(),
    exposedPorts: z.array(z.object({
      internal: z.number(),
      external: z.number().optional(),
      protocol: z.string().optional(),
      description: z.string().optional(),
    })).optional(),
    connectionInfo: z.array(z.object({
      label: z.string(),
      value: z.string(),
      copyRef: z.string().optional(),
    })).optional(),
    cpuLimit: z.number().positive().max(64).nullable().optional(),
    memoryLimit: z.number().int().min(64).max(65536).nullable().optional(),
    diskWriteAlertThreshold: z.number().int().min(0).nullable().optional(),
    projectId: z.string().min(1, "Project is required"),
  })
  .refine(
    (data) => {
      if (data.source === "git") return !!data.gitUrl;
      if (data.deployType === "image") return !!data.imageName;
      // A direct build with no image needs compose content to build from.
      if (data.source === "direct") return !!data.composeContent;
      return true;
    },
    {
      message: "Required fields missing for the selected configuration",
    }
  );

export type CreateAppInput = z.infer<typeof createAppSchema>;
