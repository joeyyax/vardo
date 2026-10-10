// One POST to a push provider through the outbound guard, with its status and body.

import { safeFetch } from "@/lib/security/safe-fetch";
import { getOutboundPolicy } from "@/lib/security/outbound-policy";

const TIMEOUT_MS = 10_000;
const DETAIL_MAX = 200;

/** The provider refused the message, or the request never reached it. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerStatus?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ProviderResponse = { status: number; body: unknown };

/** Credentials and URLs replaced with "****" so a provider's echo or a network error can't leak them. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("****");
  return out;
}

function detailOf(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const key of ["error", "description", "message", "errors"]) {
      const v = b[key];
      if (typeof v === "string") return v;
      if (Array.isArray(v) && v.length) return v.join("; ");
    }
  }
  return "";
}

/** POSTs JSON. Throws ProviderError on a non-2xx answer or a failed request, so dispatch retries and a test reports it. */
export async function postJson(
  provider: string,
  url: string,
  payload: unknown,
  opts: { headers?: Record<string, string>; secrets?: readonly string[] } = {},
): Promise<ProviderResponse> {
  const secrets = opts.secrets ?? [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...opts.headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
      policy: await getOutboundPolicy(),
    });
    const raw = await response.text().catch(() => "");
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      // Plain text stays.
    }
    if (!response.ok) {
      const detail = scrub(detailOf(body), secrets).replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX);
      throw new ProviderError(`${provider} answered ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
    }
    return { status: response.status, body };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const reason = err instanceof Error ? (err.name === "AbortError" ? "timed out" : err.message) : String(err);
    throw new ProviderError(`${provider} request failed: ${scrub(reason, secrets)}`);
  } finally {
    clearTimeout(timer);
  }
}
