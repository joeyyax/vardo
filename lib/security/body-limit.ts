// Next buffers request bodies for proxy.ts and drops everything past this size.

export const PROXY_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

type HeaderSource = { get(name: string): string | null };

/** The refusal for a body the proxy can't pass on whole, or null when it fits. */
export function bodyRefusal(headers: HeaderSource): { status: 411 | 413; error: string } | null {
  const length = headers.get("content-length");
  if (length !== null) {
    const bytes = Number(length);
    if (Number.isFinite(bytes) && bytes > PROXY_BODY_LIMIT_BYTES) {
      return { status: 413, error: "Request body is larger than 32 MB" };
    }
    return null;
  }
  if (headers.get("transfer-encoding")?.toLowerCase().includes("chunked")) {
    return { status: 411, error: "Send a Content-Length; chunked bodies aren't accepted here" };
  }
  return null;
}
