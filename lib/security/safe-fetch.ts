// ---------------------------------------------------------------------------
// Outbound fetch
//
// Vetting a URL once is not enough when redirects are followed: a public host
// answering 302 to http://169.254.169.254/ walks straight through a check that
// only looked at what the operator typed. Redirects are followed here instead,
// one hop at a time, each vetted like the first.
// ---------------------------------------------------------------------------

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
 * fetch() that refuses to reach private, loopback or link-local addresses, on
 * the first request and on every redirect it follows.
 *
 * A redirect that changes host drops credentials and signatures — the new host
 * was not who the payload was signed for.
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

    // 303 always becomes GET; 301 and 302 do so for anything that was not one,
    // matching what every other client does. 307 and 308 keep method and body.
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
