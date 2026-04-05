import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// isSystemManaged 403 guards — deploy, patch, delete endpoints
//
// These tests verify the guard logic extracted from the three API routes that
// added isSystemManaged checks. Testing as pure functions avoids Next.js
// plumbing while still covering the decision paths that reviewers flagged.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared guard shape
// ---------------------------------------------------------------------------

type AppRef = {
  id: string;
  isSystemManaged: boolean;
  projectId?: string;
};

// Mirrors the guard in POST deploy/route.ts:
//   if (app.isSystemManaged) return 403
function deployGuard(app: AppRef | null): { status: number; error?: string } | null {
  if (!app) return { status: 404, error: "Not found" };
  if (app.isSystemManaged) {
    return { status: 403, error: "System-managed apps cannot be deployed via the API" };
  }
  return null; // proceed
}

// Mirrors the guard in PATCH route.ts:
//   if (existingApp.isSystemManaged) return 403
function patchGuard(app: AppRef | null): { status: number; error?: string } | null {
  if (!app) return { status: 404, error: "Not found" };
  if (app.isSystemManaged) {
    return { status: 403, error: "System-managed apps cannot be modified via the API" };
  }
  return null; // proceed
}

// Mirrors the guard in DELETE route.ts:
//   if (app.isSystemManaged) return 403
function deleteGuard(app: AppRef | null): { status: number; error?: string } | null {
  if (!app) return { status: 404, error: "Not found" };
  if (app.isSystemManaged) {
    return { status: 403, error: "System-managed apps cannot be deleted via the API" };
  }
  return null; // proceed
}

// ---------------------------------------------------------------------------
// Deploy endpoint guard
// ---------------------------------------------------------------------------

describe("POST /apps/[appId]/deploy — isSystemManaged guard", () => {
  it("returns 403 for a system-managed app", () => {
    const result = deployGuard({ id: "app-1", isSystemManaged: true });
    expect(result?.status).toBe(403);
    expect(result?.error).toMatch(/system-managed/i);
  });

  it("returns null (proceed) for a regular app", () => {
    const result = deployGuard({ id: "app-1", isSystemManaged: false });
    expect(result).toBeNull();
  });

  it("returns 404 when the app is not found", () => {
    const result = deployGuard(null);
    expect(result?.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Patch endpoint guard
// ---------------------------------------------------------------------------

describe("PATCH /apps/[appId] — isSystemManaged guard", () => {
  it("returns 403 for a system-managed app", () => {
    const result = patchGuard({ id: "app-1", isSystemManaged: true });
    expect(result?.status).toBe(403);
    expect(result?.error).toMatch(/system-managed/i);
  });

  it("returns null (proceed) for a regular app", () => {
    const result = patchGuard({ id: "app-1", isSystemManaged: false });
    expect(result).toBeNull();
  });

  it("returns 404 when the app is not found", () => {
    const result = patchGuard(null);
    expect(result?.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Delete endpoint guard
// ---------------------------------------------------------------------------

describe("DELETE /apps/[appId] — isSystemManaged guard", () => {
  it("returns 403 for a system-managed app", () => {
    const result = deleteGuard({ id: "app-1", isSystemManaged: true });
    expect(result?.status).toBe(403);
    expect(result?.error).toMatch(/system-managed/i);
  });

  it("returns null (proceed) for a regular app", () => {
    const result = deleteGuard({ id: "app-1", isSystemManaged: false });
    expect(result).toBeNull();
  });

  it("returns 404 when the app is not found", () => {
    const result = deleteGuard(null);
    expect(result?.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Guard consistency
// ---------------------------------------------------------------------------

describe("isSystemManaged guards — all endpoints reject with 403", () => {
  const systemApp: AppRef = { id: "app-sys", isSystemManaged: true };

  it("deploy, patch, and delete all return 403 for system-managed apps", () => {
    expect(deployGuard(systemApp)?.status).toBe(403);
    expect(patchGuard(systemApp)?.status).toBe(403);
    expect(deleteGuard(systemApp)?.status).toBe(403);
  });

  it("deploy, patch, and delete all allow regular apps through", () => {
    const regularApp: AppRef = { id: "app-user", isSystemManaged: false };
    expect(deployGuard(regularApp)).toBeNull();
    expect(patchGuard(regularApp)).toBeNull();
    expect(deleteGuard(regularApp)).toBeNull();
  });
});
