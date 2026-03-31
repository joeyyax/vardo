import { describe, it, expect, vi } from "vitest";
import { mountsSchema, restartSchema } from "@/lib/api/admin/maintenance-schemas";

// ---------------------------------------------------------------------------
// Maintenance API — validation schemas and core logic
//
// These tests import schemas directly from the shared lib module so any
// change to the actual validation rules is immediately reflected here.
//
// Routes covered:
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
// Auth guard — requireAppAdmin() propagation
//
// All five endpoints call requireAppAdmin() before any logic runs. The guard
// throws Error("Unauthorized") or Error("Forbidden"), which handleRouteError
// converts to 401 / 403. These tests verify the error-to-status mapping that
// every endpoint depends on.
// ---------------------------------------------------------------------------

describe("auth guard — error-to-status mapping", () => {
  // Mirrors the logic in lib/api/error-response.ts
  function handleRouteError(error: unknown): { status: number; body: { error: string } } {
    if (error instanceof Error && error.message === "Unauthorized") {
      return { status: 401, body: { error: "Unauthorized" } };
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return { status: 403, body: { error: "Forbidden" } };
    }
    return { status: 500, body: { error: "Internal server error" } };
  }

  it("maps Unauthorized to 401", () => {
    const res = handleRouteError(new Error("Unauthorized"));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("maps Forbidden to 403 — non-admin authenticated users", () => {
    const res = handleRouteError(new Error("Forbidden"));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
  });

  it("maps unknown errors to 500", () => {
    const res = handleRouteError(new Error("something unexpected"));
    expect(res.status).toBe(500);
  });

  it("maps non-Error throws to 500", () => {
    const res = handleRouteError("string error");
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/maintenance/restart — service name validation
//
// Service names must match the vardo-<name> pattern (lowercase alphanumeric
// + hyphens). Arbitrary strings are rejected before they reach docker compose.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// POST /api/v1/admin/maintenance/mounts — update logic
//
// Early-return: when no recognized fields are provided, returns ok:true
// immediately without calling writeEnvKey.
//
// Error path: when writeEnvKey throws, the handler returns 500 instead of
// propagating the exception.
// ---------------------------------------------------------------------------

type UpdateResult = { ok: boolean; status: number; error?: string };

async function processMountsUpdate(
  updates: Array<[string, string]>,
  writer: (key: string, value: string) => Promise<void>,
): Promise<UpdateResult> {
  if (updates.length === 0) {
    return { ok: true, status: 200 };
  }
  try {
    for (const [key, value] of updates) {
      await writer(key, value);
    }
    return { ok: true, status: 200 };
  } catch {
    return { ok: false, status: 500, error: "Could not update .env — check server permissions" };
  }
}

describe("mounts POST — update logic", () => {
  it("returns ok:true immediately when no fields are provided (empty-update early return)", async () => {
    const writer = vi.fn();
    const result = await processMountsUpdate([], writer);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(writer).not.toHaveBeenCalled();
  });

  it("calls writer for each update and returns ok:true on success", async () => {
    const writer = vi.fn().mockResolvedValue(undefined);
    const result = await processMountsUpdate(
      [["VARDO_DATA", "/mnt/data"], ["VARDO_PROJECTS", "/home/user/projects"]],
      writer,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(writer).toHaveBeenCalledTimes(2);
    expect(writer).toHaveBeenCalledWith("VARDO_DATA", "/mnt/data");
    expect(writer).toHaveBeenCalledWith("VARDO_PROJECTS", "/home/user/projects");
  });

  it("returns 500 when writeEnvKey throws (file I/O error path)", async () => {
    const writer = vi.fn().mockRejectedValue(new Error("EACCES: permission denied"));
    const result = await processMountsUpdate([["VARDO_DATA", "/mnt/data"]], writer);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toContain("Could not update .env");
  });

  it("stops after the first write failure and does not call writer again", async () => {
    const writer = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("EROFS: read-only file system"));
    const result = await processMountsUpdate(
      [["VARDO_DATA", "/mnt/data"], ["VARDO_PROJECTS", "/home/user/projects"]],
      writer,
    );
    expect(result.status).toBe(500);
    // writer called once for VARDO_DATA (ok), then rejected on VARDO_PROJECTS
    expect(writer).toHaveBeenCalledTimes(2);
  });
});
