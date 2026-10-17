// A slot in a linked instance's build gate for a build sent there: claim, renew and release over a signed call.

import type { MeshBuilderStats } from "@/lib/docker/mesh-builder";
import { MeshClientError, meshSignedPost } from "./client";

export const BUILD_SLOT_PATH = "/api/v1/mesh/build-slot";

export type BuildSlotAction = "claim" | "renew" | "release" | "builder";

/** The peer's answer: whether the caller holds the slot after the call. */
export type BuildSlotReply = { held: boolean };

/** The peer's answer to `builder`: its isolated builder's OOM kills and memory limit. */
export type BuilderReply = { builder: MeshBuilderStats };

/** `unsupported` is a peer without the endpoint; `unreachable` one that didn't answer. Both build without a slot, as before. */
export type PeerClaim = "granted" | "full" | "unsupported" | "unreachable";

/** How long a peer without the endpoint isn't asked again. */
export const UNSUPPORTED_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 10_000;

type Post = (peerId: string, path: string, payload: unknown, opts: { timeoutMs: number }) => Promise<{ data: unknown }>;

const unsupported = new Map<string, number>();

/** Test hook. */
export function resetPeerSlots(): void {
  unsupported.clear();
}

async function call(peerId: string, action: BuildSlotAction, token: string, post: Post): Promise<boolean> {
  const { data } = await post(peerId, BUILD_SLOT_PATH, { action, token }, { timeoutMs: CALL_TIMEOUT_MS });
  return (data as Partial<BuildSlotReply> | null)?.held === true;
}

export async function claimPeerSlot(peerId: string, token: string, post: Post = meshSignedPost): Promise<PeerClaim> {
  const at = unsupported.get(peerId);
  if (at !== undefined && Date.now() - at < UNSUPPORTED_MS) return "unsupported";
  try {
    return (await call(peerId, "claim", token, post)) ? "granted" : "full";
  } catch (err) {
    if (err instanceof MeshClientError && err.statusCode === 404) {
      unsupported.set(peerId, Date.now());
      return "unsupported";
    }
    return "unreachable";
  }
}

/** False once the peer let the lease lapse; null when it didn't answer. */
export async function renewPeerSlot(peerId: string, token: string, post: Post = meshSignedPost): Promise<boolean | null> {
  return call(peerId, "renew", token, post).catch(() => null);
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);

/** The peer's isolated builder's OOM kills and limit; null from a peer that didn't answer or predates the action. */
export async function peerBuilderStats(peerId: string, token: string, post: Post = meshSignedPost): Promise<MeshBuilderStats | null> {
  try {
    const { data } = await post(peerId, BUILD_SLOT_PATH, { action: "builder", token }, { timeoutMs: CALL_TIMEOUT_MS });
    const builder = (data as Partial<BuilderReply> | null)?.builder;
    return builder ? { oomKills: count(builder.oomKills), limitBytes: count(builder.limitBytes) } : null;
  } catch {
    return null;
  }
}

export async function releasePeerSlot(peerId: string, token: string, post: Post = meshSignedPost): Promise<void> {
  await call(peerId, "release", token, post).catch(() => {});
}
