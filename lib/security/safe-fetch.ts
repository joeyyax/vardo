// Outbound fetch that vets every redirect hop, since a public host can 302 to a private address.

import { assertOutboundUrlAllowed, BlockedUrlError, type OutboundPolicy } from "./ssrf";

const MAX_REDIRECTS = 5;

/** Headers that must not survive a hop to a different host. */
const SENSITIVE_HEADERS = ["authorization", "cookie", "x-signature-256", "x-vardo-signature"];

function stripSensitive(headers: Headers): Headers {
  const next = new Headers(headers);
  for (const name of SENSITIVE_HEADERS) next.delete(name);
  return next;
}

export type SafeFetchOptions = RequestInit & {
  policy?: OutboundPolicy;
  maxRedirects?: number;
};

/**
 * fetch() that refuses private, loopback and link-local addresses on every hop.
 * A redirect to another host drops credentials and signatures.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const { policy, maxRedirects = MAX_REDIRECTS, ...init } = options;

  let url = await assertOutboundUrlAllowed(rawUrl, policy);
  let method = init.method ?? "GET";
  let body = init.body;
  let headers = new Headers(init.headers);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetch(url.toString(), { ...init, method, body, headers, redirect: "manual" });

    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || !location) {
      return response;
    }

    if (hop === maxRedirects) {
      throw new BlockedUrlError(`Too many redirects from ${rawUrl} (stopped after ${maxRedirects})`);
    }

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new BlockedUrlError(`Redirect to an unreadable location: ${location}`);
    }

    const validated = await assertOutboundUrlAllowed(next.toString(), policy);

    if (validated.host !== url.host) headers = stripSensitive(headers);

    // 303 always becomes GET; 301 and 302 do for non-GET/HEAD. 307 and 308 keep method and body.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
      headers.delete("content-length");
    }

    url = validated;
  }

  // The loop returns or throws; this satisfies the compiler.
  throw new BlockedUrlError(`Too many redirects from ${rawUrl}`);
}
