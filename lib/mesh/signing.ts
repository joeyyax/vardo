// HMAC request signing for peer calls that act as a user, on top of the peer bearer token.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { redis } from "@/lib/redis";

export const SIGNATURE_HEADER = "x-vardo-mesh-signature";
export const TIMESTAMP_HEADER = "x-vardo-mesh-timestamp";
export const NONCE_HEADER = "x-vardo-mesh-nonce";

/** How far a signed request's timestamp may drift from the receiver's clock. */
export const MAX_SKEW_MS = 60_000;

const NONCE_RE = /^[0-9a-f]{32}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(method: string, path: string, timestamp: string, nonce: string, body: string): string {
  return [method.toUpperCase(), path, timestamp, nonce, sha256(body)].join("\n");
}

/** Both sides hold this key: the sender derives it from the raw token, the receiver stores it as tokenHash. */
function hmac(key: string, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}

/** Signature headers for a request carrying `body` to `path` on the peer that issued `token`. */
export function signMeshRequest(opts: {
  token: string;
  method: string;
  path: string;
  body: string;
  now?: number;
  nonce?: string;
}): Record<string, string> {
  const timestamp = String(opts.now ?? Date.now());
  const nonce = opts.nonce ?? randomBytes(16).toString("hex");
  return {
    [TIMESTAMP_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
    [SIGNATURE_HEADER]: hmac(sha256(opts.token), canonical(opts.method, opts.path, timestamp, nonce, opts.body)),
  };
}

export type SignatureCheck = { ok: true; nonce: string } | { ok: false; reason: string };

/** Checks signature, freshness and nonce format. Replay is checked separately by claimNonce. */
export function verifyMeshSignature(opts: {
  tokenHash: string;
  method: string;
  path: string;
  body: string;
  headers: Headers;
  now?: number;
}): SignatureCheck {
  const timestamp = opts.headers.get(TIMESTAMP_HEADER) ?? "";
  const nonce = opts.headers.get(NONCE_HEADER) ?? "";
  const signature = opts.headers.get(SIGNATURE_HEADER) ?? "";

  if (!/^\d{1,16}$/.test(timestamp) || !NONCE_RE.test(nonce) || !/^[0-9a-f]{64}$/.test(signature)) {
    return { ok: false, reason: "Missing or malformed signature" };
  }
  if (Math.abs((opts.now ?? Date.now()) - Number(timestamp)) > MAX_SKEW_MS) {
    return { ok: false, reason: "Signature expired; check both instances' clocks" };
  }

  const expected = hmac(opts.tokenHash, canonical(opts.method, opts.path, timestamp, nonce, opts.body));
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) {
    return { ok: false, reason: "Bad signature" };
  }
  return { ok: true, nonce };
}

/** True the first time a peer uses `nonce` inside the skew window. Fails closed when Redis is down. */
export async function claimNonce(peerId: string, nonce: string): Promise<boolean> {
  try {
    const set = await redis.set(`mesh:nonce:${peerId}:${nonce}`, "1", "PX", MAX_SKEW_MS * 2, "NX");
    return set === "OK";
  } catch {
    return false;
  }
}
