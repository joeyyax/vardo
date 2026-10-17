// Request headers a monitor sends. Values are secrets: this validates them and never prints one.

export const MAX_HEADERS = 10;
export const MAX_HEADER_NAME = 64;
export const MAX_HEADER_VALUE = 1024;
export const MAX_HEADERS_TOTAL = 4096;

/** Headers a monitor may not set: the target is picked by the URL, and the connection belongs to the runner. */
const BLOCKED = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "expect",
  "cache-control",
  "user-agent",
]);

const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const BAD_VALUE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export type HeaderInput = { name: string; value: string };

/** The reason a header set is refused, or null. Reasons never include a value. */
export function headersProblem(headers: HeaderInput[]): string | null {
  if (headers.length > MAX_HEADERS) return `Use at most ${MAX_HEADERS} headers.`;
  const seen = new Set<string>();
  let total = 0;
  for (const { name, value } of headers) {
    const lower = name.toLowerCase();
    if (!name || name.length > MAX_HEADER_NAME || !TOKEN.test(name)) return `"${name.slice(0, MAX_HEADER_NAME)}" isn't a valid header name.`;
    if (BLOCKED.has(lower)) return `${name} can't be set on a monitor.`;
    if (seen.has(lower)) return `${name} is listed twice.`;
    seen.add(lower);
    if (!value || value.length > MAX_HEADER_VALUE || BAD_VALUE.test(value)) return `The value for ${name} must be 1 to ${MAX_HEADER_VALUE} characters, on one line.`;
    total += name.length + value.length;
  }
  if (total > MAX_HEADERS_TOTAL) return "The headers are too large.";
  return null;
}

/** `Authorization: Basic …` for a username and password. */
export function basicAuthHeader(username: string, password: string): HeaderInput {
  return { name: "Authorization", value: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

/** Drops anything the runner must not send. Used on headers that arrive from a linked instance. */
export function sendableHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const list = Object.entries(headers).map(([name, value]) => ({ name, value }));
  return headersProblem(list) ? {} : headers;
}
