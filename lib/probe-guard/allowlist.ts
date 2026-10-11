// The admin's never-ban list: addresses and ranges the guard never bans, reports or imports.

import { z } from "zod";
import { cidrMatcher } from "@/lib/cloudflare-ips";
import { parseCidr } from "./ban-policy";

export const MAX_ALLOW_ENTRIES = 200;
export const MIN_PREFIX = { 4: 8, 6: 16 } as const;

export type AllowEntry = {
  id: string;
  /** An IP or CIDR, normalized. */
  value: string;
  note: string;
  /** The guard's probe, trap and canary routers leave this address alone. */
  skipGuard: boolean;
  addedBy: string | null;
  addedAt: string;
};

/** Why a value can't go on the list, or null. */
export function allowValueProblem(raw: string): string | null {
  const parsed = parseCidr(raw);
  if (!parsed) return `"${raw.slice(0, 64)}" isn't an IP address or CIDR range`;
  if (parsed.prefix === 0) return "A /0 range would allow every address";
  const min = MIN_PREFIX[parsed.family];
  if (parsed.prefix < min) return `IPv${parsed.family} ranges can't be broader than /${min}`;
  return null;
}

/** The stored form: a bare address, or address/prefix for a range. */
export function normalizeAllowValue(raw: string): string {
  const parsed = parseCidr(raw);
  if (!parsed) return raw.trim();
  const max = parsed.family === 4 ? 32 : 128;
  return parsed.prefix === max ? parsed.addr : `${parsed.addr}/${parsed.prefix}`;
}

export const allowEntryInputSchema = z
  .object({
    value: z
      .string()
      .trim()
      .max(64)
      .superRefine((v, ctx) => {
        const problem = allowValueProblem(v);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      })
      .transform(normalizeAllowValue),
    note: z.string().trim().max(200).default(""),
    skipGuard: z.boolean().default(false),
  })
  .strict();

export type AllowEntryInput = z.input<typeof allowEntryInputSchema>;

export const allowEntryPatchSchema = z
  .object({ note: z.string().trim().max(200).optional(), skipGuard: z.boolean().optional() })
  .strict();

const storedEntrySchema = z.object({
  id: z.string().min(1).max(64),
  value: z.string().refine((v) => allowValueProblem(v) === null),
  note: z.string().max(200).catch(""),
  skipGuard: z.boolean().catch(false),
  addedBy: z.string().nullable().catch(null),
  addedAt: z.string().catch(() => new Date(0).toISOString()),
});

/** A stored list read defensively: malformed entries are dropped. */
export function normalizeAllowlist(raw: unknown): AllowEntry[] {
  const list = Array.isArray(raw) ? raw : (raw as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => storedEntrySchema.safeParse(e))
    .filter((r) => r.success)
    .map((r) => r.data as AllowEntry)
    .slice(0, MAX_ALLOW_ENTRIES);
}

/** The bans an entry covers. */
export function bansCovered<T extends { ip: string }>(bans: readonly T[], value: string): T[] {
  const match = cidrMatcher([value]);
  return bans.filter((b) => match(b.ip));
}
