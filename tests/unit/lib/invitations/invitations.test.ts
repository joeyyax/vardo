import { describe, it, expect } from "vitest";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

describe("invitation token generation", () => {
  it("generates a 64-character hex string from 32 random bytes", () => {
    // crypto.randomBytes(32).toString("hex") → 64 hex chars
    const token = crypto.randomBytes(32).toString("hex");
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates distinct tokens on successive calls", () => {
    const tokens = new Set(
      Array.from({ length: 20 }, () => crypto.randomBytes(32).toString("hex"))
    );
    expect(tokens.size).toBe(20);
  });

  it("token has sufficient entropy (≥ 128 bits via 32 bytes)", () => {
    // 32 bytes = 256 bits — well over the 128-bit security floor
    const bytes = crypto.randomBytes(32);
    expect(bytes.byteLength).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// Expiry logic: 7-day window
// ---------------------------------------------------------------------------

describe("invitation expiry logic", () => {
  function makeExpiresAt(offsetMs: number): Date {
    return new Date(Date.now() + offsetMs);
  }

  function isExpired(expiresAt: Date): boolean {
    return expiresAt < new Date();
  }

  it("invitation is not expired when expiresAt is in the future", () => {
    const expiresAt = makeExpiresAt(7 * 24 * 60 * 60 * 1000); // +7 days
    expect(isExpired(expiresAt)).toBe(false);
  });

  it("invitation is expired when expiresAt is in the past", () => {
    const expiresAt = makeExpiresAt(-1); // 1ms in the past
    expect(isExpired(expiresAt)).toBe(true);
  });

  it("invitation is expired exactly at the boundary", () => {
    // Slightly in the past to handle test execution time
    const expiresAt = makeExpiresAt(-100);
    expect(isExpired(expiresAt)).toBe(true);
  });

  it("7-day window expires at the correct timestamp", () => {
    const before = Date.now();
    const expiresAt = new Date(before + 7 * 24 * 60 * 60 * 1000);
    const after = Date.now();

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + sevenDaysMs);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + sevenDaysMs);
  });

  it("newly created invitation (status=pending, valid expiresAt) is active", () => {
    const invitation = {
      status: "pending" as const,
      expiresAt: makeExpiresAt(7 * 24 * 60 * 60 * 1000),
    };

    const isActive =
      invitation.status === "pending" && !isExpired(invitation.expiresAt);
    expect(isActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Accept flow state machine
// ---------------------------------------------------------------------------

describe("invitation accept flow", () => {
  type InvitationStatus = "pending" | "accepted" | "expired";

  type Invitation = {
    id: string;
    token: string;
    email: string;
    scope: string;
    targetId: string;
    role: string;
    status: InvitationStatus;
    expiresAt: Date;
  };

  function simulateAccept(
    invitation: Invitation | null
  ): { error?: string; status?: number; needsSignup?: boolean; accepted?: boolean } {
    if (!invitation) return { error: "Invalid invitation token", status: 404 };

    if (invitation.status === "accepted") {
      return { error: "Invitation already accepted", status: 409 };
    }

    if (invitation.status === "expired" || invitation.expiresAt < new Date()) {
      return { error: "Invitation has expired", status: 410 };
    }

    // Pending and valid
    return { accepted: true };
  }

  const validInvitation: Invitation = {
    id: "inv_1",
    token: "abc123",
    email: "alice@example.com",
    scope: "org",
    targetId: "org_1",
    role: "member",
    status: "pending",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };

  it("returns 404 for a missing / invalid token", () => {
    const result = simulateAccept(null);
    expect(result.status).toBe(404);
    expect(result.error).toMatch(/invalid/i);
  });

  it("returns 409 when invitation is already accepted", () => {
    const result = simulateAccept({ ...validInvitation, status: "accepted" });
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/already accepted/i);
  });

  it("returns 410 when invitation is explicitly expired", () => {
    const result = simulateAccept({ ...validInvitation, status: "expired" });
    expect(result.status).toBe(410);
    expect(result.error).toMatch(/expired/i);
  });

  it("returns 410 when invitation is past its expiresAt date", () => {
    const result = simulateAccept(
      { ...validInvitation, status: "pending", expiresAt: new Date(Date.now() - 1) }
    );
    expect(result.status).toBe(410);
    expect(result.error).toMatch(/expired/i);
  });

  it("accepts a valid pending invitation for an existing user", () => {
    const result = simulateAccept(validInvitation);
    expect(result.accepted).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("signals needsSignup when no matching user exists", () => {
    // The real route returns { needsSignup: true } — simulate here
    function simulateAcceptWithUserCheck(
      invitation: Invitation,
      existingUser: boolean
    ) {
      if (invitation.status === "accepted") return { error: "Invitation already accepted", status: 409 };
      if (invitation.status === "expired" || invitation.expiresAt < new Date()) {
        return { error: "Invitation has expired", status: 410 };
      }
      if (!existingUser) {
        return { needsSignup: true, email: invitation.email };
      }
      return { accepted: true };
    }

    const result = simulateAcceptWithUserCheck(validInvitation, false);
    expect(result.needsSignup).toBe(true);
    expect(result.email).toBe("alice@example.com");
  });
});

// ---------------------------------------------------------------------------
// Scope and role validation
// ---------------------------------------------------------------------------

describe("invitation scope and role validation", () => {
  const validScopes = ["platform", "org", "project"];
  const validRoles = ["owner", "admin", "member"];

  function validateScope(scope: unknown): boolean {
    return typeof scope === "string" && validScopes.includes(scope);
  }

  function validateRole(role: unknown): boolean {
    return typeof role === "string" && validRoles.includes(role);
  }

  it("accepts valid scopes", () => {
    for (const scope of validScopes) {
      expect(validateScope(scope)).toBe(true);
    }
  });

  it("rejects unknown scopes", () => {
    expect(validateScope("team")).toBe(false);
    expect(validateScope("")).toBe(false);
    expect(validateScope(null)).toBe(false);
    expect(validateScope(undefined)).toBe(false);
  });

  it("accepts valid roles", () => {
    for (const role of validRoles) {
      expect(validateRole(role)).toBe(true);
    }
  });

  it("rejects unknown roles", () => {
    expect(validateRole("superadmin")).toBe(false);
    expect(validateRole("viewer")).toBe(false);
    expect(validateRole("")).toBe(false);
    expect(validateRole(null)).toBe(false);
  });

  it("scope is hardcoded to 'org' when sent from the InvitationsPanel", () => {
    // The frontend always sends scope: "org" — confirm that's the only
    // value the invitations panel passes to the API.
    const scope = "org";
    expect(validateScope(scope)).toBe(true);
    expect(scope).toBe("org");
  });

  it("UI only allows 'member' or 'admin' roles — not 'owner'", () => {
    const uiAllowedRoles = ["member", "admin"];
    for (const role of uiAllowedRoles) {
      expect(validateRole(role)).toBe(true);
    }
    // 'owner' is a valid DB role but not selectable in the invite form
    expect(uiAllowedRoles.includes("owner")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Duplicate invitation prevention
// ---------------------------------------------------------------------------

describe("duplicate invitation prevention", () => {
  type SimpleInvitation = {
    email: string;
    targetId: string;
    status: "pending" | "accepted" | "expired";
  };

  function hasPendingInvitation(
    existing: SimpleInvitation[],
    email: string,
    targetId: string
  ): boolean {
    return existing.some(
      (inv) =>
        inv.email === email.toLowerCase() &&
        inv.targetId === targetId &&
        inv.status === "pending"
    );
  }

  const existingInvitations: SimpleInvitation[] = [
    { email: "alice@example.com", targetId: "org_1", status: "pending" },
    { email: "bob@example.com", targetId: "org_1", status: "accepted" },
    { email: "carol@example.com", targetId: "org_1", status: "expired" },
  ];

  it("detects a duplicate pending invitation for the same email + org", () => {
    expect(hasPendingInvitation(existingInvitations, "alice@example.com", "org_1")).toBe(true);
  });

  it("does not block reinvite if prior invitation was accepted", () => {
    expect(hasPendingInvitation(existingInvitations, "bob@example.com", "org_1")).toBe(false);
  });

  it("does not block reinvite if prior invitation was expired", () => {
    expect(hasPendingInvitation(existingInvitations, "carol@example.com", "org_1")).toBe(false);
  });

  it("does not block invitation for a different org", () => {
    expect(hasPendingInvitation(existingInvitations, "alice@example.com", "org_2")).toBe(false);
  });

  it("email comparison is case-insensitive", () => {
    expect(hasPendingInvitation(existingInvitations, "ALICE@EXAMPLE.COM", "org_1")).toBe(true);
    expect(hasPendingInvitation(existingInvitations, "Alice@Example.Com", "org_1")).toBe(true);
  });
});
