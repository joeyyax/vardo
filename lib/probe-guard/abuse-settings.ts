// Abuse reporting and blocklist settings. Client-safe; the API key is stored apart and never sent back.

import { z } from "zod";

export const MIN_CONFIDENCE = 75;
/** AbuseIPDB's free tier allows 1,000 reports a day. */
export const MAX_DAILY_CAP = 1000;

export type AbuseSettings = {
  reporting: { enabled: boolean; dailyCap: number };
  blocklists: {
    abuseipdb: { enabled: boolean; minConfidence: number };
    spamhaus: { enabled: boolean };
  };
};

export const DEFAULT_ABUSE_SETTINGS: AbuseSettings = {
  reporting: { enabled: false, dailyCap: 500 },
  blocklists: {
    abuseipdb: { enabled: false, minConfidence: 90 },
    spamhaus: { enabled: false },
  },
};

export const abuseSettingsSchema = z
  .object({
    reporting: z.object({ enabled: z.boolean(), dailyCap: z.number().int().min(1).max(MAX_DAILY_CAP) }).strict(),
    blocklists: z
      .object({
        abuseipdb: z.object({ enabled: z.boolean(), minConfidence: z.number().int().min(MIN_CONFIDENCE).max(100) }).strict(),
        spamhaus: z.object({ enabled: z.boolean() }).strict(),
      })
      .strict(),
  })
  .strict();

/** A stored value read defensively; anything malformed falls back to the defaults, which are all off. */
export function normalizeAbuseSettings(raw: unknown): AbuseSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_ABUSE_SETTINGS;
  const r = raw as Partial<AbuseSettings>;
  const d = DEFAULT_ABUSE_SETTINGS;
  const merged = {
    reporting: { ...d.reporting, ...(r.reporting ?? {}) },
    blocklists: {
      abuseipdb: { ...d.blocklists.abuseipdb, ...(r.blocklists?.abuseipdb ?? {}) },
      spamhaus: { ...d.blocklists.spamhaus, ...(r.blocklists?.spamhaus ?? {}) },
    },
  };
  const parsed = abuseSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_ABUSE_SETTINGS;
}

/** Body for saving: settings plus an optional new key. Omitting `apiKey` keeps the stored one; null removes it. */
export const abuseSettingsBodySchema = z
  .object({
    settings: abuseSettingsSchema,
    apiKey: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9]+$/, "That doesn't look like an AbuseIPDB key").nullable().optional(),
  })
  .strict();

export type BlocklistSourceStatus = {
  count: number;
  fetchedAt: string | null;
  attemptedAt: string | null;
  error: string | null;
  /** The setting the last fetch used, so a change fetches again. */
  fetchedWith?: string | null;
};

export type AbuseStatus = {
  reporting: { lastError: string | null; lastErrorAt: string | null; lastReportedAt: string | null };
  blocklists: { abuseipdb: BlocklistSourceStatus; spamhaus: BlocklistSourceStatus };
};

const EMPTY_SOURCE: BlocklistSourceStatus = { count: 0, fetchedAt: null, attemptedAt: null, error: null, fetchedWith: null };

export const EMPTY_ABUSE_STATUS: AbuseStatus = {
  reporting: { lastError: null, lastErrorAt: null, lastReportedAt: null },
  blocklists: { abuseipdb: EMPTY_SOURCE, spamhaus: EMPTY_SOURCE },
};

export function normalizeAbuseStatus(raw: unknown): AbuseStatus {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<AbuseStatus>;
  return {
    reporting: { ...EMPTY_ABUSE_STATUS.reporting, ...(r.reporting ?? {}) },
    blocklists: {
      abuseipdb: { ...EMPTY_SOURCE, ...(r.blocklists?.abuseipdb ?? {}) },
      spamhaus: { ...EMPTY_SOURCE, ...(r.blocklists?.spamhaus ?? {}) },
    },
  };
}
