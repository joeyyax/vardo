import { describe, it, expect } from "vitest";
import { generateInvitationToken, hashInvitationToken } from "@/lib/invitations/token";

describe("invitation tokens", () => {
  it("stores only a hash the raw token reproduces", () => {
    const { raw, hash } = generateInvitationToken();
    expect(hash).not.toBe(raw);
    expect(hashInvitationToken(raw)).toBe(hash);
  });

  it("matches the hash migration 0075 gives tokens issued before it", () => {
    // encode(sha256(convert_to('0a1b2c3d4e5f', 'UTF8')), 'hex') in Postgres.
    expect(hashInvitationToken("0a1b2c3d4e5f")).toBe(
      "cd584cc95f0793d8ca8ed18e7024764a1cc6f75c655011968901e21254250475",
    );
  });
});
