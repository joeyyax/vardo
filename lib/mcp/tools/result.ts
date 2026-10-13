import { z } from "zod";

export const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

export const failure = (error: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
  isError: true as const,
});

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** The `limit` argument shared by list tools. */
export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe(`Rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`);

/** A `limit` clamped to 1..MAX_LIMIT, for handlers called without schema parsing. */
export function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
}

export const iso = (date: Date | string | null | undefined): string | null =>
  date ? new Date(date).toISOString() : null;
