import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { eq, like } from "drizzle-orm";

const INVITE_PREFIX = "mesh_invite:";
const INVITE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface MeshInvite {
  code: string;
  hubPublicKey: string;
  hubEndpoint: string;
  hubInternalIp: string;
  expiresAt: number;
}

/**
 * Generate an invite and return a self-contained token.
 * The token encodes the hub's API URL + the short code so the joining
 * instance knows where to call without any extra input.
 *
 * Format: base64url("hubApiUrl|code")
 */
export async function createInvite(hub: {
  publicKey: string;
  endpoint: string;
  internalIp: string;
  apiUrl: string;
}): Promise<string> {
  // Clean up any expired invites while we're here
  await cleanExpiredInvites();

  const code = randomBytes(4).toString("hex"); // 8-char hex code

  const invite: MeshInvite = {
    code,
    hubPublicKey: hub.publicKey,
    hubEndpoint: hub.endpoint,
    hubInternalIp: hub.internalIp,
    expiresAt: Date.now() + INVITE_TTL_MS,
  };

  await db
    .insert(systemSettings)
    .values({
      key: `${INVITE_PREFIX}${code}`,
      value: JSON.stringify(invite),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: JSON.stringify(invite),
        updatedAt: new Date(),
      },
    });

  // Encode hub URL + code into a self-contained token
  const payload = `${hub.apiUrl}|${code}`;
  return Buffer.from(payload).toString("base64url");
}

/** Decode an invite token into { hubApiUrl, code }. Returns null if malformed. */
export function decodeInviteToken(
  token: string
): { hubApiUrl: string; code: string } | null {
  try {
    const payload = Buffer.from(token, "base64url").toString("utf-8");
    const pipeIdx = payload.indexOf("|");
    if (pipeIdx < 1) return null;
    const hubApiUrl = payload.slice(0, pipeIdx);
    const code = payload.slice(pipeIdx + 1);
    if (!hubApiUrl || !code) return null;
    return { hubApiUrl, code };
  } catch {
    return null;
  }
}

/**
 * Redeem an invite code atomically.
 * DELETE...RETURNING ensures only one concurrent request can succeed.
 */
export async function redeemInvite(
  code: string
): Promise<Omit<MeshInvite, "code" | "expiresAt"> | null> {
  const key = `${INVITE_PREFIX}${code}`;

  // Atomic delete — if two requests race, only one gets the row back
  const deleted = await db
    .delete(systemSettings)
    .where(eq(systemSettings.key, key))
    .returning();

  if (deleted.length === 0) return null;

  const invite: MeshInvite = JSON.parse(deleted[0].value);

  if (Date.now() > invite.expiresAt) {
    // Already deleted, and it was expired — return null
    return null;
  }

  return {
    hubPublicKey: invite.hubPublicKey,
    hubEndpoint: invite.hubEndpoint,
    hubInternalIp: invite.hubInternalIp,
  };
}

/** Remove expired invite codes from system_settings. */
async function cleanExpiredInvites(): Promise<void> {
  const rows = await db.query.systemSettings.findMany({
    where: like(systemSettings.key, `${INVITE_PREFIX}%`),
  });

  const now = Date.now();
  for (const row of rows) {
    try {
      const invite: MeshInvite = JSON.parse(row.value);
      if (now > invite.expiresAt) {
        await db
          .delete(systemSettings)
          .where(eq(systemSettings.key, row.key));
      }
    } catch {
      // Malformed entry — clean it up
      await db.delete(systemSettings).where(eq(systemSettings.key, row.key));
    }
  }
}
