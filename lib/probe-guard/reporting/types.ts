// What an abuse reporter takes. Categories are provider-neutral; each reporter maps them to its own.

export const REPORT_CATEGORIES = ["web-attack", "hacking", "bad-bot", "iot"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export type AbuseReport = {
  ip: string;
  categories: ReportCategory[];
  /** Built from fixed labels and sanitized paths only. */
  comment: string;
};

export type KeyCheck = { ok: true } | { ok: false; error: string };

export interface AbuseReporter {
  id: string;
  label: string;
  report(report: AbuseReport, apiKey: string): Promise<void>;
  /** Checks the key against a documentation address, never a real one. */
  testKey(apiKey: string): Promise<KeyCheck>;
}

/** A 429. `perAddress` means the address was reported too recently, not that the key is out of quota. */
export class ReportRateLimited extends Error {
  readonly status = 429;
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
    readonly perAddress: boolean,
  ) {
    super(message);
    this.name = "ReportRateLimited";
  }
}
