// Blocklist sources, in render priority after local bans.

import { createAbuseIpdbBlocklist } from "./abuseipdb";
import { createSpamhausDrop } from "./spamhaus";
import type { BlocklistProvider } from "./types";

export function blocklistProviders(doFetch: typeof fetch = fetch): BlocklistProvider[] {
  return [createAbuseIpdbBlocklist(doFetch), createSpamhausDrop(doFetch)];
}
