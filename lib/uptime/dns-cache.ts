// A 60 second DNS cache for uptime checks. The policy check and the connect of a check share one answer, and a monitor
// checked every 30 seconds resolves once in two. Failed lookups aren't cached.

import { lookup } from "node:dns/promises";

export type Answer = { address: string; family: number };
export type Lookup = (host: string) => Promise<Answer[]>;

export const DNS_TTL_MS = 60_000;
const MAX_ENTRIES = 5000;

const direct: Lookup = async (host) => (await lookup(host, { all: true })).map((a) => ({ address: a.address, family: a.family }));

/** A lookup that answers from memory for `ttlMs` after the last miss. */
export function cachedLookup(inner: Lookup = direct, ttlMs = DNS_TTL_MS, now: () => number = Date.now): Lookup & { clear(): void } {
  const entries = new Map<string, { at: number; answers: Answer[] }>();
  const pending = new Map<string, Promise<Answer[]>>();
  const resolve = (async (raw: string) => {
    const host = raw.toLowerCase();
    const hit = entries.get(host);
    if (hit && now() - hit.at < ttlMs) return hit.answers;
    const inflight = pending.get(host);
    if (inflight) return inflight;
    const fresh = inner(host)
      .then((answers) => {
        if (answers.length > 0) {
          if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
          entries.set(host, { at: now(), answers });
        }
        return answers;
      })
      .finally(() => pending.delete(host));
    pending.set(host, fresh);
    return fresh;
  }) as Lookup & { clear(): void };
  resolve.clear = () => {
    entries.clear();
    pending.clear();
  };
  return resolve;
}

/** The process-wide cache uptime checks use. */
export const uptimeLookup = cachedLookup();
