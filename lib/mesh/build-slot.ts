// A slot in a linked instance's build gate for a build sent there: claim, renew and release over a signed call.

import type { MeshBuilderStats } from "@/lib/docker/mesh-builder";
import { MeshClientError, meshSignedPost } from "./client";

export const BUILD_SLOT_PATH = "/api/v1/mesh/build-slot";

export type BuildSlotAction = "claim" | "renew" | "release" | "builder";

/**
 * Why a peer refused a claim: `memory` when both its builders couldn't grow to their limits, `full` when its gate had no slot.
 * `needBytes` and `freeBytes` are what the builders could grow into and the memory free for them; `busy` is whether its own builds hold slots.
 * Peers before this field send none; every field may be missing.
 */
export type PeerRefusal = { reason: "memory" | "full"; needBytes?: number | null; freeBytes?: number | null; busy?: boolean | null };

/** The peer's answer: whether the caller holds the slot after the call, and why not on a refused claim. */
export type BuildSlotReply = { held: boolean; refusal?: PeerRefusal };

/** The peer's answer to `builder`: its isolated builder's OOM kills and memory limit, and whether its own builds hold slots. */
export type BuilderReply = { builder: MeshBuilderStats; busy?: boolean };

/** `unsupported` is a peer without the endpoint; `unreachable` one that didn't answer. Both build without a slot, as before. */
export type PeerClaim = "granted" | "full" | "unsupported" | "unreachable";

/** A claim's outcome; `refusal` only on `full`, and null from a peer that didn't say why. */
export type PeerSlot = { claim: PeerClaim; refusal: PeerRefusal | null };

/** How long a peer without the endpoint isn't asked again. */
export const UNSUPPORTED_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 10_000;

type Post = (peerId: string, path: string, payload: unknown, opts: { timeoutMs: number }) => Promise<{ data: unknown }>;

const unsupported = new Map<string, number>();

/** Test hook. */
export function resetPeerSlots(): void {
  unsupported.clear();
}

async function reply(peerId: string, action: BuildSlotAction, token: string, post: Post): Promise<Partial<BuildSlotReply> | null> {
  const { data } = await post(peerId, BUILD_SLOT_PATH, { action, token }, { timeoutMs: CALL_TIMEOUT_MS });
  return data as Partial<BuildSlotReply> | null;
}

async function call(peerId: string, action: BuildSlotAction, token: string, post: Post): Promise<boolean> {
  return (await reply(peerId, action, token, post))?.held === true;
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);
const flag = (b: unknown) => (typeof b === "boolean" ? b : null);

/** The refusal's fields the caller can trust; null when the peer sent none. */
export function parseRefusal(raw: unknown): PeerRefusal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.reason !== "memory" && r.reason !== "full") return null;
  return { reason: r.reason, needBytes: count(r.needBytes), freeBytes: count(r.freeBytes), busy: flag(r.busy) };
}

export async function claimPeerSlot(peerId: string, token: string, post: Post = meshSignedPost): Promise<PeerSlot> {
  const at = unsupported.get(peerId);
  if (at !== undefined && Date.now() - at < UNSUPPORTED_MS) return { claim: "unsupported", refusal: null };
  try {
    const data = await reply(peerId, "claim", token, post);
    return data?.held === true ? { claim: "granted", refusal: null } : { claim: "full", refusal: parseRefusal(data?.refusal) };
  } catch (err) {
    if (err instanceof MeshClientError && err.statusCode === 404) {
      unsupported.set(peerId, Date.now());
      return { claim: "unsupported", refusal: null };
    }
    return { claim: "unreachable", refusal: null };
  }
}

/** False once the peer let the lease lapse; null when it didn't answer. */
export async function renewPeerSlot(peerId: string, token: string, post: Post = meshSignedPost): Promise<boolean | null> {
  return call(peerId, "renew", token, post).catch(() => null);
}

/** The peer's isolated builder's OOM kills and limit, and `busy` when it sends it; null from a peer that didn't answer or predates the action. */
export async function peerBuilderStats(peerId: string, token: string, post: Post = meshSignedPost): Promise<(MeshBuilderStats & { busy?: boolean }) | null> {
  try {
    const { data } = await post(peerId, BUILD_SLOT_PATH, { action: "builder", token }, { timeoutMs: CALL_TIMEOUT_MS });
    const answer = data as Partial<BuilderReply> | null;
    const builder = answer?.builder;
    if (!builder) return null;
    const stats = { oomKills: count(builder.oomKills), limitBytes: count(builder.limitBytes) };
    return typeof answer.busy === "boolean" ? { ...stats, busy: answer.busy } : stats;
  } catch {
    return null;
  }
}

export async function releasePeerSlot(peerId: string, token: string, post: Post = meshSignedPost): Promise<void> {
  await call(peerId, "release", token, post).catch(() => {});
}
