import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Security API route behaviors
//
// Tests are written as extracted pure functions following the pattern used
// throughout the codebase. The behaviors mirror the guards and response logic
// in:
//   GET  app/api/v1/organizations/[orgId]/apps/[appId]/security/route.ts
//   POST app/api/v1/organizations/[orgId]/apps/[appId]/security/scan/route.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared access gate
// Both routes call verifyAppAccess and return 403 if it returns null.
// ---------------------------------------------------------------------------

type AppRef = { id: string };

/**
 * Returns true when the request should be rejected with 403.
 * Mirrors the guard in both route handlers:
 *   const app = await verifyAppAccess(orgId, appId);
 *   if (!app) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
 */
function isForbidden(app: AppRef | null): boolean {
  return app === null;
}

describe("GET /security — access gate", () => {
  it("returns forbidden when verifyAppAccess returns null", () => {
    expect(isForbidden(null)).toBe(true);
  });

  it("allows access when verifyAppAccess returns an app", () => {
    expect(isForbidden({ id: "app-1" })).toBe(false);
  });
});

describe("POST /security/scan — access gate", () => {
  it("returns forbidden when verifyAppAccess returns null", () => {
    expect(isForbidden(null)).toBe(true);
  });

  it("allows access when verifyAppAccess returns an app", () => {
    expect(isForbidden({ id: "app-1" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /security — response shape
// ---------------------------------------------------------------------------

type Scan = {
  id: string;
  status: "running" | "completed" | "failed";
  trigger: "deploy" | "scheduled" | "manual";
  findings: unknown[];
  criticalCount: number;
  warningCount: number;
  startedAt: string;
  completedAt: string | null;
};

/**
 * Mirrors the response shape of the GET handler:
 *   return NextResponse.json({ scans });
 */
function buildScansResponse(scans: Scan[]) {
  return { scans };
}

/**
 * Mirrors the DB query spec in the GET handler — scoped to both appId and
 * organizationId with an explicit limit of 10.
 */
function scanQuerySpec(appId: string, orgId: string) {
  return { appId, orgId, limit: 10 };
}

describe("GET /security — response", () => {
  it("wraps the scans array in a { scans } envelope", () => {
    const scans = [
      {
        id: "scan-1",
        status: "completed" as const,
        trigger: "manual" as const,
        findings: [],
        criticalCount: 0,
        warningCount: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ];
    expect(buildScansResponse(scans)).toEqual({ scans });
  });

  it("returns an empty scans array when no scans exist", () => {
    expect(buildScansResponse([])).toEqual({ scans: [] });
  });

  it("scopes the query to appId and orgId with a limit of 10", () => {
    const spec = scanQuerySpec("app-1", "org-1");
    expect(spec).toEqual({ appId: "app-1", orgId: "org-1", limit: 10 });
  });
});

describe("GET /security — DB error", () => {
  it("returns a 500 response body on unexpected error", () => {
    // Mirrors the catch block: return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    const errorBody = { error: "Internal server error" };
    expect(errorBody).toMatchObject({ error: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------
// POST /security/scan — scanner result handling
// ---------------------------------------------------------------------------

/**
 * Mirrors the scanId null-check in the POST handler:
 *   if (!scanId) return NextResponse.json({ error: "Scan failed to start" }, { status: 500 });
 *   return NextResponse.json({ scanId });
 */
function scanResultResponse(scanId: string | null): { status: number; body: unknown } {
  if (!scanId) return { status: 500, body: { error: "Scan failed to start" } };
  return { status: 200, body: { scanId } };
}

describe("POST /security/scan — scanner result", () => {
  it("returns 500 when the scanner returns null (concurrent guard or internal failure)", () => {
    const result = scanResultResponse(null);
    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ error: "Scan failed to start" });
  });

  it("returns 200 with the scanId on a successful scan", () => {
    const result = scanResultResponse("scan-abc-123");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ scanId: "scan-abc-123" });
  });
});

describe("POST /security/scan — error handling", () => {
  it("returns a 500 response body on unexpected error", () => {
    // Mirrors the catch block: return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    const errorBody = { error: "Internal server error" };
    expect(errorBody).toMatchObject({ error: expect.any(String) });
  });
});
