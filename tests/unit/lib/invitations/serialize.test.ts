import { describe, it, expect } from "vitest";
import { serializeInvitation, type InvitationRow } from "@/lib/invitations/serialize";

const APP_URL = "https://vardo.example.com";

function row(over: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: "inv-1",
    email: "someone@example.com",
    role: "admin",
    status: "pending",
    token: "tok-secret-value",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    expiresAt: new Date("2026-08-08T00:00:00Z"),
    ...over,
  };
}

describe("serializeInvitation", () => {
  it("drops the token field whoever is asking", () => {
    for (const canManage of [true, false]) {
      expect(serializeInvitation(row(), { canManage, appUrl: APP_URL })).not.toHaveProperty("token");
    }
  });

  it("leaves a member nothing to reconstruct the link from — the escalation this prevents", () => {
    // A member reading a pending admin invitation could otherwise accept it.
    const out = serializeInvitation(row({ role: "admin" }), { canManage: false, appUrl: APP_URL });
    expect(out.inviteUrl).toBeNull();
    expect(JSON.stringify(out)).not.toContain("tok-secret-value");
  });

  it("gives an admin a usable link", () => {
    const out = serializeInvitation(row(), { canManage: true, appUrl: APP_URL });
    expect(out.inviteUrl).toBe(`${APP_URL}/invite/tok-secret-value`);
  });

  it("withholds the link once the invitation is no longer pending", () => {
    for (const status of ["accepted", "expired", "revoked"]) {
      const out = serializeInvitation(row({ status }), { canManage: true, appUrl: APP_URL });
      expect(out.inviteUrl).toBeNull();
    }
  });

  it("keeps the fields the list actually renders", () => {
    const out = serializeInvitation(row(), { canManage: false, appUrl: APP_URL });
    expect(out).toMatchObject({ id: "inv-1", email: "someone@example.com", role: "admin", status: "pending" });
  });
});
