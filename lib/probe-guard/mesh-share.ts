// Ban sharing between linked instances over the signed mesh channel. Both sides opt in; received bans are never sent on.

import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { normalizeIp } from "./ban-policy";
import type { BanOutcome, BanRequest } from "./bans";

const log = logger.child("probe-guard");

export const PROBE_BANS_PATH = "/api/v1/mesh/probe-bans";
const SHARE_TIMEOUT_MS = 10_000;
const SHARE_PROBE_MS = 2_000;

export const sharedBanSchema = z
  .object({
    ip: z.string().max(64).refine((v) => normalizeIp(v) !== null, "Not an IP address"),
    reason: z.enum(["threshold", "trap", "canary"]),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type SharedBan = z.infer<typeof sharedBanSchema>;

/** What goes over the wire: address, why and until when. Nothing about the app. */
export function sharePayload(ban: { ip: string; reason: string; expiresAt: Date; originPeerId?: string | null }): SharedBan | null {
  if (ban.originPeerId || ban.reason === "mesh") return null;
  const parsed = sharedBanSchema.safeParse({ ip: ban.ip, reason: ban.reason, expiresAt: ban.expiresAt.toISOString() });
  return parsed.success ? parsed.data : null;
}

export type ShareDeps = {
  peers: () => Promise<{ id: string; name: string }[]>;
  post: (peerId: string, path: string, payload: unknown) => Promise<unknown>;
};

const defaultShareDeps: ShareDeps = {
  peers: () => db.query.meshPeers.findMany({ where: eq(meshPeers.connectionType, "direct"), columns: { id: true, name: true } }),
  post: async (peerId, path, payload) => {
    const { meshSignedPost } = await import("@/lib/mesh/client");
    return meshSignedPost(peerId, path, payload, { timeoutMs: SHARE_TIMEOUT_MS, probeMs: SHARE_PROBE_MS });
  },
};

/** Sends a local ban to every directly linked instance. A refusal just means that instance hasn't opted in. */
export async function shareBan(
  ban: { ip: string; reason: string; expiresAt: Date; originPeerId?: string | null },
  deps: ShareDeps = defaultShareDeps,
): Promise<{ sent: number; failed: number }> {
  const payload = sharePayload(ban);
  if (!payload) return { sent: 0, failed: 0 };
  const peers = await deps.peers();
  const results = await Promise.allSettled(peers.map((p) => deps.post(p.id, PROBE_BANS_PATH, payload)));
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed) log.info(`Shared a ban with ${peers.length - failed} of ${peers.length} linked instances`);
  return { sent: peers.length - failed, failed };
}

export type ReceiveDeps = {
  sharingEnabled: () => Promise<boolean>;
  ban: (req: BanRequest) => Promise<BanOutcome>;
};

export type ReceiveResult = { status: 200 | 400 | 403; body: Record<string, unknown> };

/** Applies a ban a linked instance sent. The caller has checked the peer's token, signature and nonce. */
export async function receiveSharedBan(
  peer: { id: string; name: string },
  body: unknown,
  deps: ReceiveDeps,
): Promise<ReceiveResult> {
  if (!(await deps.sharingEnabled())) return { status: 403, body: { error: "This instance doesn't accept shared bans" } };
  const parsed = sharedBanSchema.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid ban" } };
  const outcome = await deps.ban({
    ip: parsed.data.ip,
    reason: "mesh",
    origin: { peerId: peer.id, name: peer.name, expiresAt: new Date(parsed.data.expiresAt) },
  });
  return { status: 200, body: { ok: true, result: outcome.status } };
}

export const PROBE_LIFTS_PATH = "/api/v1/mesh/probe-bans/lift";

export const sharedLiftSchema = z
  .object({ ip: z.string().max(64).refine((v) => normalizeIp(v) !== null, "Not an IP address") })
  .strict();

/**
 * Tells every directly linked instance an admin lifted this address's ban, so it doesn't stay blocked elsewhere.
 * Sent only for a local or mesh ban an admin lifted, never for a received lift. A refusal or an older instance
 * without this endpoint just leaves its copy to expire.
 */
export async function shareLift(ip: string, deps: ShareDeps = defaultShareDeps): Promise<{ sent: number; failed: number }> {
  const parsed = sharedLiftSchema.safeParse({ ip });
  if (!parsed.success) return { sent: 0, failed: 0 };
  const peers = await deps.peers();
  const results = await Promise.allSettled(peers.map((p) => deps.post(p.id, PROBE_LIFTS_PATH, parsed.data)));
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed) log.info(`Shared a ban lift with ${peers.length - failed} of ${peers.length} linked instances`);
  return { sent: peers.length - failed, failed };
}

export type ReceiveLiftDeps = {
  sharingEnabled: () => Promise<boolean>;
  /** Ends this instance's active bans for the address, leaving permanent and blocklist ones. Returns how many. */
  lift: (ip: string, peer: { id: string; name: string }) => Promise<number>;
};

/** Applies a lift a linked instance sent. The caller has checked the peer's token, signature and nonce. Never sent on. */
export async function receiveSharedLift(
  peer: { id: string; name: string },
  body: unknown,
  deps: ReceiveLiftDeps,
): Promise<ReceiveResult> {
  if (!(await deps.sharingEnabled())) return { status: 403, body: { error: "This instance doesn't accept shared bans" } };
  const parsed = sharedLiftSchema.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid address" } };
  const ip = normalizeIp(parsed.data.ip);
  if (!ip) return { status: 400, body: { error: "Not an IP address" } };
  return { status: 200, body: { ok: true, lifted: await deps.lift(ip, peer) } };
}
