import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    query: { systemSettings: { findMany: vi.fn().mockResolvedValue([]) } },
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
    delete: () => ({ where: async () => undefined }),
  },
}));

import { createInvite, decodeInviteToken } from "@/lib/mesh/invite";

const HUB = { publicKey: "k", endpoint: "192.0.2.1:51820", internalIp: "10.99.0.1", apiUrl: "https://hub.example.com" };

describe("mesh invite codes", () => {
  it("carry 128 bits of randomness", async () => {
    const decoded = decodeInviteToken(await createInvite(HUB));
    expect(decoded?.hubApiUrl).toBe(HUB.apiUrl);
    expect(decoded?.code).toMatch(/^[0-9a-f]{32}$/);
  });

  it("differ every time", async () => {
    const a = decodeInviteToken(await createInvite(HUB))?.code;
    const b = decodeInviteToken(await createInvite(HUB))?.code;
    expect(a).not.toBe(b);
  });
});
