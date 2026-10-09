import { z } from "zod";

// Validation schemas for the maintenance API.

/** Parses "source:destination[:ro]" or a legacy single path. Null for empty or "/dev/null". */
export function parseMountPair(
  value: string | undefined,
): { source: string; destination: string } | null {
  if (!value || value === "/dev/null") return null;

  const mountValue = value.endsWith(":ro") ? value.slice(0, -3) : value;

  const colonIndex = mountValue.indexOf(":");
  if (colonIndex === -1) {
    // Legacy single path: source = destination.
    return { source: mountValue, destination: mountValue };
  }

  const source = mountValue.slice(0, colonIndex);
  const destination = mountValue.slice(colonIndex + 1);
  if (!source || !destination) return null;
  return { source, destination };
}

// Vardo- prefixed docker compose service names.
export const SERVICE_NAME_RE = /^vardo-[a-z][a-z0-9-]*$/;

export const restartSchema = z.object({
  service: z
    .string()
    .regex(SERVICE_NAME_RE, "service must match vardo-<name> (lowercase alphanumeric with hyphens)")
    .optional(),
});

// Written straight into .env: empty clears, otherwise absolute source:destination with no newlines (they'd inject lines).
export const mountPairField = z
  .string()
  .refine(
    (v) => {
      if (v === "") return true;
      if (/[\n\r]/.test(v)) return false;
      const parts = v.split(":");
      if (parts.length !== 2) return false;
      const [source, destination] = parts;
      return source.startsWith("/") && destination.startsWith("/");
    },
    "must be a source:destination pair where both are absolute paths, or empty to clear",
  )
  .optional();

export const mountsSchema = z.object({
  vardoData: mountPairField,
  vardoProjects: mountPairField,
  vardoMount1: mountPairField,
  vardoMount2: mountPairField,
});

// Idle image reclamation. idleDays is bounded so a typo can't make every app eligible.
export const imageReclaimConfigSchema = z.object({
  enabled: z.boolean(),
  idleDays: z.number().int().min(1).max(3650),
  slots: z.boolean().optional().default(false),
  slotRollbackTargets: z.boolean().optional().default(false),
});

export const imageReclaimRunSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  /** Also sweep superseded blue-green slot generations. */
  slots: z.boolean().optional().default(false),
});

export const imageReclaimAppSchema = z.object({
  appId: z.string().min(1),
  policy: z.enum(["auto", "never", "always"]).optional(),
  idleDays: z.number().int().min(1).max(3650).nullable().optional(),
});
