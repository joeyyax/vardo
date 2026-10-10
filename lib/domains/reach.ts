// Whether a domain reaches this Vardo: fetch a short-lived token from /.well-known/vardo/ and check its HMAC.

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "crypto";
import { redis } from "@/lib/redis";
import { normalizeMasterKey } from "@/lib/crypto/key-fingerprint";
import { pinnedFetch } from "@/lib/security/pinned-fetch";
import { BlockedUrlError } from "@/lib/security/ssrf";

export const REACH_PATH = "/.well-known/vardo/";

const TOKEN_TTL_SECONDS = 120;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const PROBE_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 256;

const tokenKey = (token: string) => `domain-reach:${token}`;

function reachKey(): Buffer | null {
  const master = process.env.ENCRYPTION_MASTER_KEY;
  if (!master) return null;
  return Buffer.from(hkdfSync("sha256", normalizeMasterKey(master), "vardo-domain-reach/v1", "domain-reach", 32));
}

/** HMAC of a token, or null without a master key. */
export function signReachToken(token: string): string | null {
  const key = reachKey();
  return key ? createHmac("sha256", key).update(token).digest("hex") : null;
}

/** A fresh token, valid for two minutes. */
export async function issueReachToken(): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await redis.set(tokenKey(token), "1", "EX", TOKEN_TTL_SECONDS);
  return token;
}

export async function revokeReachToken(token: string): Promise<void> {
  await redis.del(tokenKey(token)).catch(() => {});
}

/** The body /.well-known/vardo/<token> answers with, or null for an unknown, expired or malformed token. */
export async function answerReachToken(token: string): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null;
  const issued = await redis.get(tokenKey(token)).catch(() => null);
  if (!issued) return null;
  return signReachToken(token);
}

export type ProxyProvider = "cloudflare" | "proxy";

/** The proxy in front of a response, read from its headers. */
export function proxyFromHeaders(headers: Headers): ProxyProvider | null {
  if (headers.has("cf-ray") || headers.get("server")?.trim().toLowerCase() === "cloudflare") return "cloudflare";
  const markers = ["via", "x-served-by", "x-cache", "x-fastly-request-id", "x-amz-cf-id", "fly-request-id", "x-vercel-id", "cdn-loop"];
  return markers.some((h) => headers.has(h)) ? "proxy" : null;
}

/** Statuses a proxy sends when it can't reach the server behind it. */
function isProxyFailure(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

export type ReachOutcome =
  /** The token came back signed: this Vardo answered. */
  | "verified"
  /** Something answered without the token. */
  | "other-server"
  /** Nothing answered, or only a proxy that couldn't reach its origin. */
  | "no-response"
  /** Resolves to an address the outbound policy refuses. */
  | "blocked";

export type Reach = { outcome: ReachOutcome; proxy: ProxyProvider | null };

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES + 1).toString("utf-8");
}

function signatureMatches(body: string, expected: string): boolean {
  const got = Buffer.from(body.trim());
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Fetches the token over HTTPS, then HTTP for a domain without a certificate yet. Never follows redirects. */
export async function probeReach(domain: string): Promise<Reach> {
  const token = await issueReachToken();
  const expected = signReachToken(token);
  try {
    for (const scheme of ["https", "http"] as const) {
      let res: Response;
      try {
        res = await pinnedFetch(new URL(`${scheme}://${domain}${REACH_PATH}${token}`), {
          headers: { accept: "text/plain" },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof BlockedUrlError) return { outcome: "blocked", proxy: null };
        continue;
      }
      const proxy = proxyFromHeaders(res.headers);
      if (proxy && isProxyFailure(res.status)) {
        await res.body?.cancel().catch(() => {});
        return { outcome: "no-response", proxy };
      }
      let body = "";
      if (res.status === 200) body = await readCapped(res);
      else await res.body?.cancel().catch(() => {});
      const verified = !!expected && signatureMatches(body, expected);
      return { outcome: verified ? "verified" : "other-server", proxy };
    }
    return { outcome: "no-response", proxy: null };
  } finally {
    await revokeReachToken(token);
  }
}

export type ReachVerdict = {
  configured: boolean;
  /** The token round trip confirmed it, not records alone. */
  verified: boolean;
  reachable: boolean;
};

/** Connected on a verified token. Records pointing here count only when nothing answered to ask. */
export function reachVerdict(reach: Reach, recordsPointHere: boolean): ReachVerdict {
  if (reach.outcome === "verified") return { configured: true, verified: true, reachable: true };
  if (reach.outcome === "other-server") return { configured: false, verified: false, reachable: true };
  return { configured: recordsPointHere, verified: false, reachable: false };
}
