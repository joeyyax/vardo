// Originating side of an instance sign-in: asks a linked peer for a ticket for the signed-in user.

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity";
import { MeshClientError, meshSignedPost } from "@/lib/mesh/client";
import { VERIFY_EMAIL_HINT } from "@/lib/auth/verify-email-paths";
import { INSTANCE_TICKET_PATH, REDEEM_PATH, requiresSecondFactor, type TicketRequest } from "./ticket";

export class SignInError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 502,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

export type SigningInUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled?: boolean | null;
};

/** The redeem URL a peer returned, when it's a plain http(s) link to its redeem endpoint. */
export function checkedRedeemUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.pathname !== REDEEM_PATH) return null;
    return /^[0-9a-f]{64}$/.test(url.searchParams.get("ticket") ?? "") ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A redeem URL on `peerId` for `who`. Logs the attempt under `activityOrgId`. */
export async function requestInstanceSignIn(opts: {
  who: SigningInUser;
  peerId: string;
  next?: string;
  organizationId?: string;
  activityOrgId?: string | null;
}): Promise<{ url: string; peerName: string }> {
  const peer = await db.query.meshPeers.findFirst({
    where: and(eq(meshPeers.id, opts.peerId), eq(meshPeers.connectionType, "direct")),
    columns: { id: true, name: true, peerAcceptsInstanceSignin: true },
  });
  if (!peer) throw new SignInError("No linked instance with that id", 404);
  if (!peer.peerAcceptsInstanceSignin) {
    throw new SignInError(`${peer.name} doesn't accept sign-ins from here. An admin there can turn it on.`, 403);
  }
  if (!opts.who.emailVerified) throw new SignInError(`${VERIFY_EMAIL_HINT} before signing in elsewhere.`, 403);

  const payload: TicketRequest = {
    email: opts.who.email,
    // A 2FA user only gets a session here by passing a second factor.
    secondFactor: requiresSecondFactor({ twoFactorEnabled: opts.who.twoFactorEnabled ?? null }),
    ...(opts.next && { next: opts.next }),
    ...(opts.organizationId && { organizationId: opts.organizationId }),
  };

  const log = (ok: boolean, detail: Record<string, unknown>) =>
    opts.activityOrgId
      ? recordActivity({
          organizationId: opts.activityOrgId,
          action: ok ? "mesh.instance_signin_sent" : "mesh.instance_signin_failed",
          userId: opts.who.id,
          metadata: { trigger: peer.name, peerId: peer.id, ...detail },
        }).catch(() => {})
      : Promise.resolve();

  let url: string | null;
  try {
    const { data } = await meshSignedPost<{ url?: unknown }>(peer.id, INSTANCE_TICKET_PATH, payload, {
      timeoutMs: 10_000,
      probeMs: 2_000,
    });
    url = checkedRedeemUrl(data?.url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(false, { error: message });
    const refused = err instanceof MeshClientError && err.statusCode && err.statusCode < 500;
    throw new SignInError(refused ? message : `Couldn't reach ${peer.name}: ${message}`, refused ? 403 : 502);
  }

  if (!url) {
    await log(false, { error: "Invalid sign-in link" });
    throw new SignInError(`${peer.name} returned an invalid sign-in link`, 502);
  }

  await log(true, {});
  return { url, peerName: peer.name };
}
