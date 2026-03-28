import { describe, it, expect } from "vitest";
import { isAdmin } from "@/lib/auth/permissions";

// ---------------------------------------------------------------------------
// Authorization gate: allowBindMounts is restricted to admin/owner roles.
// This mirrors the guard in PATCH /api/v1/organizations/[orgId]/projects/[projectId].
//
// The guard reads:
//   if (parsed.data.allowBindMounts !== undefined && !isAdmin(org.membership.role)) {
//     return NextResponse.json({ error: "..." }, { status: 403 });
//   }
// ---------------------------------------------------------------------------

function allowBindMountsCheck(
  allowBindMounts: boolean | undefined,
  role: string,
): { allowed: boolean; status: number } {
  if (allowBindMounts !== undefined && !isAdmin(role)) {
    return { allowed: false, status: 403 };
  }
  return { allowed: true, status: 200 };
}

describe("allowBindMounts authorization gate", () => {
  describe("non-admin roles", () => {
    it("rejects member setting allowBindMounts=true", () => {
      const result = allowBindMountsCheck(true, "member");
      expect(result.allowed).toBe(false);
      expect(result.status).toBe(403);
    });

    it("rejects member setting allowBindMounts=false", () => {
      const result = allowBindMountsCheck(false, "member");
      expect(result.allowed).toBe(false);
      expect(result.status).toBe(403);
    });

    it("allows member to update other fields (no allowBindMounts)", () => {
      const result = allowBindMountsCheck(undefined, "member");
      expect(result.allowed).toBe(true);
      expect(result.status).toBe(200);
    });
  });

  describe("admin role", () => {
    it("allows admin to set allowBindMounts=true", () => {
      const result = allowBindMountsCheck(true, "admin");
      expect(result.allowed).toBe(true);
    });

    it("allows admin to set allowBindMounts=false", () => {
      const result = allowBindMountsCheck(false, "admin");
      expect(result.allowed).toBe(true);
    });
  });

  describe("owner role", () => {
    it("allows owner to set allowBindMounts=true", () => {
      const result = allowBindMountsCheck(true, "owner");
      expect(result.allowed).toBe(true);
    });

    it("allows owner to set allowBindMounts=false", () => {
      const result = allowBindMountsCheck(false, "owner");
      expect(result.allowed).toBe(true);
    });
  });
});
