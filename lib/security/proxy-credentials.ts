import { createHash } from "crypto";

const TTL_MS = 30_000;
const MAX_ENTRIES = 5_000;

const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/;

type Verdict = { valid: boolean; at: number };
const verdicts = new Map<string, Verdict>();

function credentialsOf(headers: Headers): { bearer: string | null; cookie: string | null } {
  const auth = headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() || null : null;
  const cookie = SESSION_COOKIE.exec(headers.get("cookie") ?? "")?.[1] ?? null;
  return { bearer, cookie };
}

async function verify(headers: Headers, bearer: string | null): Promise<boolean> {
  if (bearer) {
    const { isFeatureEnabledAsync } = await import("@/lib/config/features");
    if (await isFeatureEnabledAsync("api-tokens")) {
      const { findApiToken } = await import("@/lib/auth/api-token");
      if (await findApiToken(bearer)) return true;
    }
  }
  const { auth } = await import("@/lib/auth");
  return !!(await auth.api.getSession({ headers }));
}

/**
 * Whether the request carries a session or API token the server accepts.
 * Verdicts are cached for 30 seconds. With `lookup` false a cache miss counts as invalid,
 * so forged credentials can't drive database reads past the caller's own limit.
 */
export async function hasValidCredentials(
  headers: Headers,
  opts: { lookup: boolean; now?: number },
): Promise<boolean> {
  const { bearer, cookie } = credentialsOf(headers);
  if (!bearer && !cookie) return false;

  const now = opts.now ?? Date.now();
  const key = createHash("sha256").update(`${bearer ?? ""}\n${cookie ?? ""}`).digest("hex");
  const hit = verdicts.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.valid;
  if (!opts.lookup) return false;

  let valid: boolean;
  try {
    valid = await verify(headers, bearer);
  } catch {
    return false;
  }

  if (verdicts.size >= MAX_ENTRIES) {
    const oldest = verdicts.keys().next().value;
    if (oldest) verdicts.delete(oldest);
  }
  verdicts.set(key, { valid, at: now });
  return valid;
}

/** Test hook. */
export function clearCredentialVerdicts(): void {
  verdicts.clear();
}
