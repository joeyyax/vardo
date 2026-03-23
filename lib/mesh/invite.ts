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

/** Generate a short invite code and store it in system settings. */
export async function createInvite(hub: {
  publicKey: string;
  endpoint: string;
  internalIp: string;
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

  return code;
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
