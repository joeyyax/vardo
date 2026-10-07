// ---------------------------------------------------------------------------
// Invitation tokens. Only the SHA-256 hash is stored; the raw token lives in
// the link and is shown once, when it's issued.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from "crypto";

export function hashInvitationToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateInvitationToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: hashInvitationToken(raw) };
}

export function invitationUrl(raw: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${appUrl}/invite/${raw}`;
}
