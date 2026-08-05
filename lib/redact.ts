// ---------------------------------------------------------------------------
// Secret redaction for text that leaves the process — error messages, command
// lines, captured stderr, deployment logs.
//
// A match is replaced whole: no length, no prefix, no suffix survives.
// ---------------------------------------------------------------------------

export const REDACTED = "[redacted]";

/** Shortest value worth redacting by exact match — below this it is noise. */
const MIN_VALUE_LENGTH = 6;

const PATTERNS: { pattern: RegExp; replacement: string }[] = [
  // PEM blocks — the whole body, not just the header.
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
  // URL credentials: scheme://user:pass@host and scheme://token@host.
  {
    pattern: /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^\s@]*@/gi,
    replacement: `$1${REDACTED}:${REDACTED}@`,
  },
  {
    pattern: /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+@/gi,
    replacement: `$1${REDACTED}@`,
  },
  // Provider token shapes, which travel outside any recognisable key/value form.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: REDACTED },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: REDACTED },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replacement: REDACTED },
  // Authorization headers.
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1 ${REDACTED}` },
  // Docker config auth blobs.
  { pattern: /("auth"\s*:\s*)"[^"]*"/g, replacement: `$1"${REDACTED}"` },
  // Environment assignments whose name says secret.
  {
    pattern:
      /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|PWD)[A-Za-z0-9_]*)=\S+/gi,
    replacement: `$1=${REDACTED}`,
  },
  // CLI flags that carry a credential, joined or separated.
  {
    pattern:
      /(--(?:password|passwd|pass|token|secret|secret-key|secret-access-key|access-key|access-key-id|api-key|auth|credential)[a-z-]*)(=|\s+)(?!-)\S+/gi,
    replacement: `$1$2${REDACTED}`,
  },
  { pattern: /(\s-p)(?!\s)\S+/g, replacement: `$1${REDACTED}` },
];

/** Replaces every occurrence of the given literal values. */
export function redactValues(text: string, values: Iterable<string>): string {
  let out = text;
  for (const value of values) {
    if (typeof value !== "string" || value.length < MIN_VALUE_LENGTH) continue;
    out = out.replaceAll(value, REDACTED);
  }
  return out;
}

/** Replaces anything shaped like a credential. */
export function redactSecrets(text: string, values: Iterable<string> = []): string {
  let out = redactValues(text, values);
  for (const { pattern, replacement } of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Fields a failed child process carries the command line and its output in. */
const ERROR_TEXT_FIELDS = ["message", "cmd", "stdout", "stderr", "stack"] as const;

/**
 * Rewrites an error's text in place so a credential on argv cannot survive
 * into whatever logs it. Non-errors are returned untouched.
 */
export function redactError<T>(error: T, values: Iterable<string> = []): T {
  if (!error || typeof error !== "object") return error;

  const target = error as Record<string, unknown>;
  for (const field of ERROR_TEXT_FIELDS) {
    const value = target[field];
    if (typeof value !== "string") continue;
    try {
      target[field] = redactSecrets(value, values);
    } catch {
      // Frozen or getter-only field — the remaining fields still get cleaned.
    }
  }
  return error;
}
