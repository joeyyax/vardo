// URL job requests: SSRF-checked, timed, retried with backoff and redacted before they're stored.

import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { redactSecrets } from "@/lib/redact";
import { safeFetch, type SafeFetchOptions } from "@/lib/security/safe-fetch";
import { BlockedUrlError, type OutboundPolicy } from "@/lib/security/ssrf";
import { getOutboundPolicy } from "@/lib/security/outbound-policy";
import { backoffDelay, capDelay, retryAfterMs } from "@/lib/net/backoff";
import { isRetryableStatus } from "@/lib/net/retry";
import type { CronHeader } from "./headers";
import {
  statusMatches,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRIES,
  MAX_RETRY_WAIT_MS,
  MAX_TIMEOUT_MS,
  type CronMethod,
} from "./url-options";

/** Bytes of response body kept per run. */
export const BODY_SNIPPET_BYTES = 4096;
const BACKOFF_BASE_MS = 1_000;

export type UrlRequest = {
  url: string;
  method?: CronMethod | string;
  headers?: CronHeader[];
  timeoutMs?: number;
  retries?: number;
  expectedStatus?: string | null;
};

export type UrlResult = {
  success: boolean;
  log: string;
  durationMs: number;
  httpStatus?: number;
  attempts: number;
  target: string;
};

export type UrlDeps = {
  fetch?: (url: string, init: SafeFetchOptions) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: number;
  random?: () => number;
};

/** Outbound policy for an org's URL jobs. A trusted org may reach the job's own host on a private address. */
export async function cronOutboundPolicy(organizationId: string, url: string): Promise<OutboundPolicy> {
  const base = await getOutboundPolicy();
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
    columns: { trusted: true },
  });
  if (!org?.trusted) return base;
  try {
    return { allowlist: [...(base.allowlist ?? []), new URL(url).hostname] };
  } catch {
    return base;
  }
}

async function readSnippet(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < BODY_SNIPPET_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(size, BODY_SNIPPET_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, bytes.length - offset);
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= bytes.length) break;
  }
  const text = new TextDecoder().decode(bytes);
  return size > BODY_SNIPPET_BYTES ? `${text}\n…(truncated)` : text;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Wait before retry `attempt`: jittered backoff, or the server's Retry-After, within the cap. */
function retryWaitMs(attempt: number, requested: number | null, baseMs: number, random?: () => number): number {
  const backoff = backoffDelay(attempt, { baseMs, maxMs: MAX_RETRY_WAIT_MS, random });
  return capDelay(Math.max(backoff, requested ?? 0), MAX_RETRY_WAIT_MS);
}

/** Sends the request, retrying failures with exponential backoff. Never throws. */
export async function runUrlRequest(
  req: UrlRequest,
  policy: OutboundPolicy,
  deps: UrlDeps = {},
): Promise<UrlResult> {
  const doFetch = deps.fetch ?? safeFetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = deps.backoffMs ?? BACKOFF_BASE_MS;
  const method = (req.method ?? "GET").toUpperCase();
  const timeoutMs = clamp(req.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const retries = clamp(req.retries ?? 0, 0, MAX_RETRIES);
  const secrets = (req.headers ?? []).map((h) => h.value);
  const redact = (text: string) => redactSecrets(text, secrets, 4);
  const target = redact(req.url);

  const started = Date.now();
  const lines: string[] = [];
  let httpStatus: number | undefined;
  let attempts = 0;

  let requestedWait: number | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryWaitMs(attempt, requestedWait, backoff, deps.random));
    requestedWait = null;
    attempts = attempt + 1;
    const tag = retries > 0 ? ` (attempt ${attempts} of ${retries + 1})` : "";
    const attemptStart = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(req.url, {
        method,
        headers: Object.fromEntries((req.headers ?? []).map((h) => [h.name, h.value])),
        signal: controller.signal,
        policy,
      });
      httpStatus = res.status;
      const body = method === "HEAD" ? "" : await readSnippet(res);
      const ms = Date.now() - attemptStart;
      const ok = statusMatches(req.expectedStatus, res.status);
      lines.push(`${method} ${target} → ${res.status} ${res.statusText} in ${ms}ms${tag}${ok ? "" : `, expected ${req.expectedStatus?.trim() || "2xx"}`}`);
      // A status that won't change on retry ends the run.
      if (ok || attempt === retries || !isRetryableStatus(res.status)) {
        if (body) lines.push(body);
        return { success: ok, log: redact(lines.join("\n")), durationMs: Date.now() - started, httpStatus, attempts, target };
      }
      requestedWait = retryAfterMs(res.headers);
    } catch (err) {
      const aborted = controller.signal.aborted;
      const message = aborted ? `timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err);
      lines.push(`${method} ${target} → ${message}${tag}`);
      // Policy refusals won't change on retry.
      if (err instanceof BlockedUrlError) break;
    } finally {
      clearTimeout(timer);
    }
  }

  return { success: false, log: redact(lines.join("\n")), durationMs: Date.now() - started, httpStatus, attempts, target };
}
