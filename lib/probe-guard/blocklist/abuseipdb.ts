// AbuseIPDB's blacklist endpoint. The free tier allows five fetches a day and ignores confidenceMinimum, returning 100% only.

import { isIP } from "net";
import { ABUSEIPDB_API, responseError } from "../reporting/abuseipdb";
import type { BlocklistEntry, BlocklistFetchOptions, BlocklistProvider } from "./types";

export const BLACKLIST_LIMIT = 10_000;
const TIMEOUT_MS = 60_000;

type BlacklistBody = { data?: { ipAddress?: unknown; abuseConfidenceScore?: unknown }[] };

/** Entries at or above the threshold, whatever the plan let through. */
export function parseBlacklist(body: unknown, minConfidence: number): BlocklistEntry[] {
  const data = (body as BlacklistBody)?.data;
  if (!Array.isArray(data)) throw new Error("AbuseIPDB sent an unexpected blacklist");
  const out: BlocklistEntry[] = [];
  for (const row of data) {
    const ip = typeof row?.ipAddress === "string" ? row.ipAddress.trim() : "";
    const score = typeof row?.abuseConfidenceScore === "number" ? row.abuseConfidenceScore : 0;
    if (isIP(ip) && score >= minConfidence) out.push({ value: ip, score });
  }
  return out;
}

export function createAbuseIpdbBlocklist(doFetch: typeof fetch = fetch): BlocklistProvider {
  return {
    id: "abuseipdb",
    label: "AbuseIPDB",
    kind: "addresses",
    needsKey: true,
    minIntervalMs: 3_600_000,
    async fetch(opts: BlocklistFetchOptions) {
      if (!opts.apiKey) throw new Error("Add an AbuseIPDB API key first");
      const query = new URLSearchParams({ confidenceMinimum: String(opts.minConfidence), limit: String(BLACKLIST_LIMIT) });
      const res = await doFetch(`${ABUSEIPDB_API}/blacklist?${query}`, {
        headers: { Key: opts.apiKey, Accept: "application/json" },
        signal: opts.signal ?? AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw await responseError(res);
      return parseBlacklist(await res.json(), opts.minConfidence);
    },
  };
}
