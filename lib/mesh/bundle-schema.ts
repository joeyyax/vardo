import { z } from "zod";

/**
 * Shared Zod schema for app bundles in mesh transfers.
 * Used by promote, pull, and clone endpoints.
 */
export const appBundleSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().nullable(),
  source: z.enum(["git", "direct"]),
  deployType: z.enum(["compose", "dockerfile", "image", "static", "nixpacks"]),
  gitUrl: z.string().nullable(),
  gitBranch: z.string().nullable(),
  imageName: z.string().nullable(),
  composeContent: z.string().nullable(),
  composeFilePath: z.string().nullable(),
  rootDirectory: z.string().nullable(),
  autoTraefikLabels: z.boolean().nullable(),
  containerPort: z.number().nullable(),
  backendProtocol: z.enum(["http", "https"]).nullable().optional(),
  restartPolicy: z.string().nullable(),
  exposedPorts: z.array(z.object({
    internal: z.number(),
    external: z.number().optional(),
    protocol: z.string().optional(),
    description: z.string().optional(),
  })).nullable(),
  envContent: z.string().nullable(),
  sortOrder: z.number().nullable(),
  volumes: z.array(z.object({
    name: z.string(),
    mountPath: z.string(),
    persistent: z.boolean(),
  })),
});

export const projectBundleSchema = z.object({
  sourceInstanceId: z.string(),
  project: z.object({
    name: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string().nullable(),
    color: z.string().nullable(),
  }),
  apps: z.array(appBundleSchema),
  gitRef: z.string().nullable(),
  transferType: z.enum(["promote", "pull", "clone"]),
  volumeBackupIds: z.array(z.string()).optional(),
});
