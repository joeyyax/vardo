// AbuseIPDB reporter: POST /report, with GET /check for testing a key.

import { retryAfterMs } from "@/lib/net/backoff";
import { HttpError, isRetryableError, retry } from "@/lib/net/retry";
import { ReportRateLimited, type AbuseReport, type AbuseReporter, type KeyCheck, type ReportCategory } from "./types";

export const ABUSEIPDB_API = "https://api.abuseipdb.com/api/v2";
/** RFC 5737 documentation address. */
export const TEST_KEY_IP = "198.51.100.1";
const TIMEOUT_MS = 15_000;
/** Longest Retry-After waited out inline; longer ones become a cooldown. */
export const INLINE_RETRY_MAX_MS = 60_000;

// https://www.abuseipdb.com/categories
export const ABUSEIPDB_CATEGORY_IDS: Record<ReportCategory, number> = {
  "web-attack": 21,
  hacking: 15,
  "bad-bot": 19,
  iot: 23,
};

export function abuseipdbCategories(categories: readonly ReportCategory[]): string {
  return [...new Set(categories.map((c) => ABUSEIPDB_CATEGORY_IDS[c]))].sort((a, b) => a - b).join(",");
}

/** The first error detail AbuseIPDB sent, trimmed. */
export async function errorDetail(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { errors?: { detail?: unknown }[] } | null;
  const detail = body?.errors?.[0]?.detail;
  return typeof detail === "string" ? detail.slice(0, 200) : `HTTP ${res.status}`;
}

/** A failed response as the error the queue acts on. */
export async function responseError(res: Response): Promise<Error> {
  const detail = await errorDetail(res);
  if (res.status === 429) {
    return new ReportRateLimited(`AbuseIPDB rate limit: ${detail}`, retryAfterMs(res.headers), /once in 15 minutes|same ip/i.test(detail));
  }
  return new HttpError(res.status, `AbuseIPDB answered ${res.status}: ${detail}`, retryAfterMs(res.headers));
}

export type AbuseIpdbOptions = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export function createAbuseIpdbReporter(opts: AbuseIpdbOptions = {}): AbuseReporter {
  const doFetch = opts.fetch ?? fetch;
  return {
    id: "abuseipdb",
    label: "AbuseIPDB",
    async report(report: AbuseReport, apiKey: string): Promise<void> {
      await retry(
        async () => {
          const res = await doFetch(`${ABUSEIPDB_API}/report`, {
            method: "POST",
            headers: { Key: apiKey, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ ip: report.ip, categories: abuseipdbCategories(report.categories), comment: report.comment }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!res.ok) throw await responseError(res);
        },
        {
          maxAttempts: 3,
          maxRetryAfterMs: INLINE_RETRY_MAX_MS,
          // A short Retry-After is waited out here; a long one or a per-address limit goes back to the queue.
          retryable: (err) =>
            err instanceof ReportRateLimited
              ? !err.perAddress && err.retryAfterMs !== null && err.retryAfterMs <= INLINE_RETRY_MAX_MS
              : isRetryableError(err),
          sleep: opts.sleep ? (ms) => opts.sleep!(ms) : undefined,
        },
      );
    },
    async testKey(apiKey: string): Promise<KeyCheck> {
      try {
        const url = `${ABUSEIPDB_API}/check?${new URLSearchParams({ ipAddress: TEST_KEY_IP, maxAgeInDays: "30" })}`;
        const res = await doFetch(url, { headers: { Key: apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (res.ok) return { ok: true };
        if (res.status === 401 || res.status === 403) return { ok: false, error: "AbuseIPDB didn't accept the key" };
        if (res.status === 429) return { ok: false, error: "AbuseIPDB's rate limit is reached. Try again later." };
        return { ok: false, error: `AbuseIPDB answered ${res.status}: ${await errorDetail(res)}` };
      } catch {
        return { ok: false, error: "Couldn't reach AbuseIPDB" };
      }
    },
  };
}
