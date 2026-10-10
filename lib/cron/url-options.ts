// URL job options shared by the API, MCP tools and UI. Client-safe.

import { z } from "zod";

export const CRON_METHODS = ["GET", "POST", "HEAD"] as const;
export type CronMethod = (typeof CRON_METHODS)[number];

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 300_000;
export const MAX_RETRIES = 3;
/** Longest wait between attempts, Retry-After included. */
export const MAX_RETRY_WAIT_MS = 60_000;
export const MAX_HEADERS = 20;

/** Shown in place of a stored header value. */
export const HEADER_MASK = "****";

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection"]);

type StatusRule = { from: number; to: number };

/** Rules for "2xx", "200", "200-299" or a comma list of them. Null when the spec doesn't parse. */
export function parseExpectedStatus(spec: string): StatusRule[] | null {
  const parts = spec.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const rules: StatusRule[] = [];
  for (const part of parts) {
    let m: RegExpMatchArray | null;
    if ((m = part.match(/^([1-5])xx$/i))) {
      const base = Number(m[1]) * 100;
      rules.push({ from: base, to: base + 99 });
    } else if ((m = part.match(/^(\d{3})-(\d{3})$/))) {
      const from = Number(m[1]);
      const to = Number(m[2]);
      if (from < 100 || to > 599 || from > to) return null;
      rules.push({ from, to });
    } else if ((m = part.match(/^(\d{3})$/))) {
      const code = Number(m[1]);
      if (code < 100 || code > 599) return null;
      rules.push({ from: code, to: code });
    } else {
      return null;
    }
  }
  return rules;
}

/** Whether `status` meets the spec. Null or empty means 2xx. */
export function statusMatches(spec: string | null | undefined, status: number): boolean {
  const rules = spec?.trim() ? parseExpectedStatus(spec) : [{ from: 200, to: 299 }];
  return (rules ?? []).some((r) => status >= r.from && status <= r.to);
}

export const cronHeaderInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(HEADER_NAME, "Invalid header name")
    .refine((n) => !RESERVED_HEADERS.has(n.toLowerCase()), "This header is set automatically"),
  // Omitted or the mask keeps the stored value.
  value: z.string().max(4096).optional(),
});

export type CronHeaderInput = z.infer<typeof cronHeaderInput>;

/** URL job options as a request sends them. All optional so PATCH can send any subset. */
export const urlOptionsShape = {
  method: z.enum(CRON_METHODS).optional(),
  headers: z
    .array(cronHeaderInput)
    .max(MAX_HEADERS)
    .refine((list) => new Set(list.map((h) => h.name.toLowerCase())).size === list.length, "Duplicate header name")
    .optional(),
  timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
  retries: z.number().int().min(0).max(MAX_RETRIES).optional(),
  expectedStatus: z
    .string()
    .trim()
    .max(64)
    .refine((s) => s === "" || parseExpectedStatus(s) !== null, "Use codes, classes or ranges, like 2xx or 200,204")
    .nullable()
    .optional(),
};
