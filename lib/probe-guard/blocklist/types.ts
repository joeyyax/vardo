// Blocklist sources. Address lists become 24-hour bans; range lists render as ClientIP matchers.

export type BlocklistId = "abuseipdb" | "spamhaus";

export type BlocklistEntry = {
  /** An IP for address lists, a CIDR for range lists. */
  value: string;
  /** The source's confidence, 0 to 100, when it gives one. */
  score?: number;
};

export type BlocklistFetchOptions = {
  apiKey: string | null;
  minConfidence: number;
  signal?: AbortSignal;
};

export interface BlocklistProvider {
  id: BlocklistId;
  label: string;
  kind: "addresses" | "ranges";
  needsKey: boolean;
  /** Least time between fetches the source asks for. */
  minIntervalMs: number;
  fetch(opts: BlocklistFetchOptions): Promise<BlocklistEntry[]>;
}
