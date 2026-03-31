import { describe, it, expect } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Maintenance API — validation schemas and core logic
//
// These tests mirror the validation rules in:
//   app/api/v1/admin/maintenance/route.ts
//   app/api/v1/admin/maintenance/restart/route.ts
//   app/api/v1/admin/maintenance/update/route.ts
//   app/api/v1/admin/maintenance/mounts/route.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /api/v1/admin/maintenance
//
// Returns { services, hasVardoDir } — hasVardoDir is a boolean derived from
// process.env.VARDO_DIR. The raw path must never be returned.
// ---------------------------------------------------------------------------

describe("maintenance GET — hasVardoDir shape", () => {
  function buildResponse(vardoDir: string | undefined) {
    const hasVardoDir = !!vardoDir;
    // Simulate what the route returns — must not include the raw path
    return { hasVardoDir } as const;
  }

  it("returns true when VARDO_DIR is set", () => {
    const res = buildResponse("/opt/vardo");
    expect(res.hasVardoDir).toBe(true);
  });

  it("returns false when VARDO_DIR is empty string", () => {
    const res = buildResponse("");
    expect(res.hasVardoDir).toBe(false);
  });

  it("returns false when VARDO_DIR is undefined", () => {
    const res = buildResponse(undefined);
    expect(res.hasVardoDir).toBe(false);
  });

  it("does not leak the raw filesystem path", () => {
    const res = buildResponse("/opt/vardo");
    expect(res).not.toHaveProperty("vardoDir");
    expect(Object.keys(res)).toEqual(["hasVardoDir"]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/maintenance/restart — service name validation
//
// Service names must match the vardo-<name> pattern (lowercase alphanumeric
// + hyphens). Arbitrary strings are rejected before they reach docker compose.
// ---------------------------------------------------------------------------

const SERVICE_NAME_RE = /^vardo-[a-z][a-z0-9-]*$/;

const restartSchema = z.object({
  service: z
    .string()
    .regex(SERVICE_NAME_RE, "service must match vardo-<name> (lowercase alphanumeric with hyphens)")
    .optional(),
});

describe("restart — service name validation", () => {
  it("accepts a valid service name", () => {
    expect(restartSchema.safeParse({ service: "vardo-frontend" }).success).toBe(true);
  });

  it("accepts omitted service (restart all)", () => {
    expect(restartSchema.safeParse({}).success).toBe(true);
  });

  it("rejects arbitrary strings", () => {
    expect(restartSchema.safeParse({ service: "nginx" }).success).toBe(false);
  });

  it("rejects shell metacharacters", () => {
    expect(restartSchema.safeParse({ service: "vardo-frontend; rm -rf /" }).success).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    expect(restartSchema.safeParse({ service: "../../etc/passwd" }).success).toBe(false);
  });

  it("rejects empty service string", () => {
    expect(restartSchema.safeParse({ service: "" }).success).toBe(false);
  });

  it("rejects uppercase service names", () => {
    expect(restartSchema.safeParse({ service: "vardo-Frontend" }).success).toBe(false);
  });

  it("accepts hyphenated names", () => {
    expect(restartSchema.safeParse({ service: "vardo-my-service" }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/maintenance/update — VARDO_DIR guard
//
// Returns 503 when VARDO_DIR is not set. The git pull and docker compose
// commands are only run when the directory is known.
// ---------------------------------------------------------------------------

describe("update — VARDO_DIR guard", () => {
  function checkVardoDir(vardoDir: string | undefined): { ok: boolean; status: number } {
    if (!vardoDir) {
      return { ok: false, status: 503 };
    }
    return { ok: true, status: 200 };
  }

  it("returns 503 when VARDO_DIR is not set", () => {
    expect(checkVardoDir(undefined).status).toBe(503);
  });

  it("returns 503 when VARDO_DIR is empty string", () => {
    expect(checkVardoDir("").status).toBe(503);
  });

  it("proceeds when VARDO_DIR is set", () => {
    expect(checkVardoDir("/opt/vardo").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/maintenance/mounts — response shape
//
// Returns the current host mount configuration from process.env.
// ---------------------------------------------------------------------------

describe("mounts GET — response shape", () => {
  function buildMountsResponse(env: Record<string, string | undefined>) {
    return {
      vardoData: env.VARDO_DATA || null,
      vardoProjects: env.VARDO_PROJECTS || null,
      vardoMount1: env.VARDO_MOUNT_1 || null,
      vardoMount2: env.VARDO_MOUNT_2 || null,
    };
  }

  it("returns null for unset mounts", () => {
    const res = buildMountsResponse({});
    expect(res.vardoData).toBeNull();
    expect(res.vardoProjects).toBeNull();
    expect(res.vardoMount1).toBeNull();
    expect(res.vardoMount2).toBeNull();
  });

  it("returns configured mount paths", () => {
    const res = buildMountsResponse({ VARDO_DATA: "/mnt/data", VARDO_PROJECTS: "/home/user/projects" });
    expect(res.vardoData).toBe("/mnt/data");
    expect(res.vardoProjects).toBe("/home/user/projects");
    expect(res.vardoMount1).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/maintenance/mounts — mountPathField validation
//
// Empty string clears the mount. Non-empty values must be absolute paths
// with no newline characters (which would inject lines into .env).
// ---------------------------------------------------------------------------

const mountPathField = z
  .string()
  .refine(
    (v) => v === "" || (v.startsWith("/") && !/[\n\r]/.test(v)),
    "path must be an absolute path without newline characters, or empty to clear",
  )
  .optional();

const mountsSchema = z.object({
  vardoData: mountPathField,
  vardoProjects: mountPathField,
  vardoMount1: mountPathField,
  vardoMount2: mountPathField,
});

describe("mounts POST — mountPathField validation", () => {
  it("accepts a valid absolute path", () => {
    expect(mountsSchema.safeParse({ vardoData: "/mnt/data" }).success).toBe(true);
  });

  it("accepts empty string to clear a mount", () => {
    expect(mountsSchema.safeParse({ vardoData: "" }).success).toBe(true);
  });

  it("accepts undefined (field not provided)", () => {
    expect(mountsSchema.safeParse({}).success).toBe(true);
  });

  it("rejects relative paths", () => {
    expect(mountsSchema.safeParse({ vardoData: "mnt/data" }).success).toBe(false);
  });

  it("rejects newline injection in path value", () => {
    expect(mountsSchema.safeParse({ vardoData: "/mnt/data\nMALICIOUS=1" }).success).toBe(false);
  });

  it("rejects carriage-return injection", () => {
    expect(mountsSchema.safeParse({ vardoData: "/mnt/data\rINJECTED=1" }).success).toBe(false);
  });

  it("accepts a path with spaces (valid on some systems)", () => {
    expect(mountsSchema.safeParse({ vardoData: "/mnt/my data" }).success).toBe(true);
  });

  it("accepts all four mounts set at once", () => {
    expect(
      mountsSchema.safeParse({
        vardoData: "/mnt/data",
        vardoProjects: "/home/user/projects",
        vardoMount1: "/opt/extra",
        vardoMount2: "/opt/other",
      }).success,
    ).toBe(true);
  });

  it("accepts clearing all mounts with empty strings", () => {
    expect(
      mountsSchema.safeParse({
        vardoData: "",
        vardoProjects: "",
        vardoMount1: "",
        vardoMount2: "",
      }).success,
    ).toBe(true);
  });

  it("rejects a path that starts with a newline", () => {
    expect(mountsSchema.safeParse({ vardoData: "\n/mnt/data" }).success).toBe(false);
  });
});
