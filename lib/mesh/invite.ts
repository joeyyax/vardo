import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

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

/** Redeem an invite code. Returns hub connection info or null if invalid/expired. */
export async function redeemInvite(
  code: string
): Promise<Omit<MeshInvite, "code" | "expiresAt"> | null> {
  const key = `${INVITE_PREFIX}${code}`;

  const row = await db.query.systemSettings.findFirst({
    where: eq(systemSettings.key, key),
  });

  if (!row) return null;

  const invite: MeshInvite = JSON.parse(row.value);

  if (Date.now() > invite.expiresAt) {
    // Expired — clean up
    await db.delete(systemSettings).where(eq(systemSettings.key, key));
    return null;
  }

  // One-time use — delete after redeem
  await db.delete(systemSettings).where(eq(systemSettings.key, key));

  return {
    hubPublicKey: invite.hubPublicKey,
    hubEndpoint: invite.hubEndpoint,
    hubInternalIp: invite.hubInternalIp,
  };
}
