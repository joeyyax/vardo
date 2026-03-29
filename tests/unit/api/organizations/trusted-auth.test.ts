import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Authorization gate: trusted is restricted to platform admins (isAppAdmin).
// This mirrors the guard in PATCH /api/v1/organizations/[orgId].
//
// The guard reads:
//   if (parsed.data.trusted !== undefined) {
//     try {
//       await requireAppAdmin();
//     } catch {
//       return NextResponse.json({ error: "Forbidden" }, { status: 403 });
//     }
//   }
//
// requireAppAdmin throws "Forbidden" when the caller is not a platform admin.
// Org admins and owners cannot set trusted — only platform admins may.
// ---------------------------------------------------------------------------

function trustedGateForbidden(
  trusted: boolean | undefined,
  isAppAdmin: boolean,
): { allowed: boolean; status: number } {
  if (trusted !== undefined && !isAppAdmin) {
    return { allowed: false, status: 403 };
  }
  return { allowed: true, status: 200 };
}

describe("trusted flag authorization gate", () => {
  describe("non-platform-admin users", () => {
    it("rejects org owner attempting to set trusted=true", () => {
      const result = trustedGateForbidden(true, false);
      expect(result.allowed).toBe(false);
      expect(result.status).toBe(403);
    });

    it("rejects org owner attempting to set trusted=false", () => {
      const result = trustedGateForbidden(false, false);
      expect(result.allowed).toBe(false);
      expect(result.status).toBe(403);
    });

    it("allows org owner to update other fields (no trusted in payload)", () => {
      const result = trustedGateForbidden(undefined, false);
      expect(result.allowed).toBe(true);
      expect(result.status).toBe(200);
    });
  });

  describe("platform admin", () => {
    it("allows platform admin to set trusted=true", () => {
      const result = trustedGateForbidden(true, true);
      expect(result.allowed).toBe(true);
    });

    it("allows platform admin to set trusted=false", () => {
      const result = trustedGateForbidden(false, true);
      expect(result.allowed).toBe(true);
    });

    it("allows platform admin to update other fields (no trusted in payload)", () => {
      const result = trustedGateForbidden(undefined, true);
      expect(result.allowed).toBe(true);
    });
  });
});
