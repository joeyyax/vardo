import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/logger";

const log = logger.child("api");

const ACRONYMS: Record<string, string> = {
  api: "API", cpu: "CPU", dns: "DNS", id: "ID", ip: "IP", ssh: "SSH",
  tls: "TLS", ttl: "TTL", url: "URL", uri: "URI", mb: "MB", gb: "GB",
};

const defaultLocale = z.locales.en().localeError;

/** `gitUrl` -> "Git URL", `memory_limit` -> "Memory limit". */
export function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.toLowerCase());
  const label = words.join(" ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.?]$/.test(capped) ? capped : `${capped}.`;
}

function isDefaultMessage(issue: z.core.$ZodIssue): boolean {
  if (issue.message.startsWith("Invalid input: expected")) return true;
  const generated = defaultLocale(issue as never);
  const text = typeof generated === "string" ? generated : generated?.message;
  return text === issue.message;
}

/** Render the first zod issue as a plain sentence, e.g. "Name is required." */
export function describeIssue(issue: z.core.$ZodIssue | undefined): string {
  const fallback = "Check the highlighted fields.";
  if (!issue) return fallback;
  if (!isDefaultMessage(issue)) return sentence(issue.message);

  const key = [...issue.path].reverse().find((p) => typeof p === "string");
  if (!key) return fallback;
  const field = fieldLabel(key);

  switch (issue.code) {
    case "invalid_type":
      return /received undefined$/.test(issue.message)
        ? `${field} is required.`
        : `${field} must be a ${issue.expected}.`;
    case "too_small":
      if (issue.origin === "string") {
        return Number(issue.minimum) <= 1
          ? `${field} is required.`
          : `${field} must be at least ${issue.minimum} characters.`;
      }
      if (issue.origin === "array" || issue.origin === "set") {
        return `${field} needs at least ${issue.minimum}.`;
      }
      return `${field} must be at least ${issue.minimum}.`;
    case "too_big":
      if (issue.origin === "string") return `${field} must be at most ${issue.maximum} characters.`;
      if (issue.origin === "array" || issue.origin === "set") {
        return `${field} allows at most ${issue.maximum}.`;
      }
      return `${field} must be at most ${issue.maximum}.`;
    case "invalid_value":
      return issue.values.length > 0 && issue.values.length <= 6
        ? `${field} must be one of ${issue.values.map(String).join(", ")}.`
        : `${field} isn't a valid option.`;
    case "unrecognized_keys":
      return `Unknown field: ${issue.keys.join(", ")}.`;
    default:
      return `${field} isn't valid.`;
  }
}

type Extra = Record<string, unknown>;

function json(status: number, error: string, extra?: Extra) {
  return NextResponse.json({ error, ...extra }, { status });
}

/** Plain-sentence API errors. Status codes and the `{ error }` shape match the raw versions. */
export const apiError = {
  unauthorized: (extra?: Extra) => json(401, "Sign in to continue.", extra),
  forbidden: (thing?: string, extra?: Extra) =>
    json(403, thing ? `You don't have access to this ${thing}.` : "You don't have access to this.", extra),
  notFound: (thing: string, extra?: Extra) =>
    json(404, `${thing.charAt(0).toUpperCase()}${thing.slice(1)} not found.`, extra),
  validation: (error: z.ZodError, opts?: { details?: boolean }) =>
    json(
      400,
      describeIssue(error.issues[0]),
      opts?.details ? { details: z.flattenError(error).fieldErrors } : undefined,
    ),
  internal: (extra?: Extra) => json(500, "Something went wrong. Try again.", extra),
};

/** Error response for API catch blocks: 401 for auth errors, else 500. */
export function handleRouteError(error: unknown, context?: string) {
  if (error instanceof Error && error.message === "Unauthorized") {
    return apiError.unauthorized();
  }
  if (error instanceof Error && error.message === "Forbidden") {
    return apiError.forbidden();
  }
  if (context) {
    log.error(`${context}:`, error);
  }
  return apiError.internal();
}

/** PostgreSQL error code from a thrown value or its `cause`. */
export function getPgErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const directCode =
    "code" in error ? (error as { code: string }).code : null;
  if (directCode) return directCode;
  if (
    error.cause &&
    typeof error.cause === "object" &&
    "code" in error.cause
  ) {
    return (error.cause as { code: string }).code;
  }
  return null;
}

/** Violated constraint name from a thrown value or its `cause`. */
export function getPgConstraint(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const direct =
    "constraint" in error ? (error as { constraint: unknown }).constraint : null;
  if (typeof direct === "string") return direct;
  if (
    error.cause &&
    typeof error.cause === "object" &&
    "constraint" in error.cause
  ) {
    const fromCause = (error.cause as { constraint: unknown }).constraint;
    if (typeof fromCause === "string") return fromCause;
  }
  return null;
}

/** Whether an error is a Postgres unique violation (23505). */
export function isUniqueViolation(error: unknown): boolean {
  return getPgErrorCode(error) === "23505";
}
