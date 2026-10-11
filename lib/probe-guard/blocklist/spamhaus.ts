// Spamhaus DROP: hijacked and criminal netblocks, free and keyless. Spamhaus asks for at most one fetch an hour.

import { HttpError } from "@/lib/net/retry";
import { parseCidr } from "../ban-policy";
import type { BlocklistEntry, BlocklistProvider } from "./types";

export const DROP_FEEDS = ["https://www.spamhaus.org/drop/drop_v4.json", "https://www.spamhaus.org/drop/drop_v6.json"];
const TIMEOUT_MS = 60_000;

/** One CIDR per JSON line; the metadata line and anything malformed are skipped. */
export function parseDropFeed(text: string): BlocklistEntry[] {
  const out: BlocklistEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: { cidr?: unknown; type?: unknown };
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (row.type != null || typeof row.cidr !== "string") continue;
    const parsed = parseCidr(row.cidr);
    if (parsed && row.cidr.includes("/")) out.push({ value: `${parsed.addr}/${parsed.prefix}` });
  }
  return out;
}

export function createSpamhausDrop(doFetch: typeof fetch = fetch): BlocklistProvider {
  return {
    id: "spamhaus",
    label: "Spamhaus DROP",
    kind: "ranges",
    needsKey: false,
    minIntervalMs: 3_600_000,
    async fetch(opts) {
      const lists = await Promise.all(
        DROP_FEEDS.map(async (url) => {
          const res = await doFetch(url, { headers: { Accept: "application/json" }, signal: opts.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
          if (!res.ok) throw new HttpError(res.status, `Spamhaus answered ${res.status}`);
          return parseDropFeed(await res.text());
        }),
      );
      return lists.flat();
    },
  };
}
