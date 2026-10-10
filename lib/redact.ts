// Secret redaction for text that leaves the process. Matches are replaced whole.

export const REDACTED = "[redacted]";

/** Shortest value redacted by exact match. */
const MIN_VALUE_LENGTH = 6;

const PATTERNS: { pattern: RegExp; replacement: string }[] = [
  // PEM blocks, whole body.
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
  // Provider token shapes.
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
  // KEY as a whole name segment: MASTER_KEY, KEY_ID, not MONKEY.
  {
    pattern: /\b((?:[A-Za-z0-9_]*_)?KEYS?(?:_[A-Za-z0-9_]*)?)=\S+/gi,
    replacement: `$1=${REDACTED}`,
  },
  // Short secret names as a whole segment: SMTP_PASS, DB_PW, SENTRY_DSN, not BYPASS.
  {
    pattern:
      /\b((?:[A-Za-z0-9_]*_)?(?:PASS|PASSPHRASE|PW|PIN|AUTH|DSN|SALT|SIG|SIGNATURE|COOKIE|SEED|CERT|LICENSE)(?:_[A-Za-z0-9_]*)?)=\S+/gi,
    replacement: `$1=${REDACTED}`,
  },
  // Values quoted in YAML, JSON or shell: PASSWORD: "x", "api_key": "x".
  {
    pattern:
      /(["']?\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|_PASS|_PW|_DSN)\b["']?\s*:\s*)(["'])[^"'\n]+\2/gi,
    replacement: `$1$2${REDACTED}$2`,
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
export function redactValues(text: string, values: Iterable<string>, minLength = MIN_VALUE_LENGTH): string {
  let out = text;
  for (const value of values) {
    if (typeof value !== "string" || value.length < minLength) continue;
    out = out.replaceAll(value, REDACTED);
  }
  return out;
}

/** Replaces anything shaped like a credential. */
export function redactSecrets(text: string, values: Iterable<string> = [], minLength = MIN_VALUE_LENGTH): string {
  let out = redactValues(text, values, minLength);
  for (const { pattern, replacement } of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Error fields that can carry the command line and its output. */
const ERROR_TEXT_FIELDS = ["message", "cmd", "stdout", "stderr", "stack"] as const;

/** Redact an error's text fields in place. Non-objects are returned untouched. */
export function redactError<T>(error: T, values: Iterable<string> = []): T {
  if (!error || typeof error !== "object") return error;

  const target = error as Record<string, unknown>;
  for (const field of ERROR_TEXT_FIELDS) {
    const value = target[field];
    if (typeof value !== "string") continue;
    try {
      target[field] = redactSecrets(value, values);
    } catch {
      // Frozen or getter-only field.
    }
  }
  return error;
}

/** Env keys whose values are secret. */
const SECRET_KEY = /SECRET|TOKEN|PASSWORD|PASSWD|PWD|KEY|PRIVATE|CREDENTIAL|DSN|AUTH|SALT|SIGNATURE|PASSPHRASE|COOKIE|(?:^|_)(?:PASS|PW|PIN|SEED)(?:_|$)/i;

/** Shortest value masked on key name alone. */
const MIN_KEYED_LENGTH = 4;

/** Shortest value masked on its shape alone. */
const MIN_SHAPED_LENGTH = 12;

const COMMON_WORDS = new Set([
  "true", "false", "production", "development", "staging", "preview", "test", "localhost", "default", "enabled", "disabled",
]);

/** Password of a URL with credentials, else null. */
function urlPassword(value: string): string | null {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:([^\s@]+)@/i.exec(value)?.[1] ?? null;
}

/** Long, mixed letters and digits, and not a path, URL or hostname. */
function looksSecret(value: string): boolean {
  if (value.length < MIN_SHAPED_LENGTH || /\s/.test(value)) return false;
  if (/[/\\]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value) && /[a-z]$/i.test(value)) return false;
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}

/**
 * Env values to mask: those under a secret-looking key or shaped like a credential.
 * Values equal to `publicNames` (app, project, org, domains) are never masked.
 */
export function secretEnvValues(env: Record<string, string>, publicNames: Iterable<string> = []): string[] {
  const skip = new Set([...publicNames].filter(Boolean).map((n) => n.toLowerCase()));
  const out = new Set<string>();
  for (const [key, raw] of Object.entries(env)) {
    if (typeof raw !== "string") continue;
    const password = urlPassword(raw);
    if (password) {
      out.add(password);
      continue;
    }
    const value = raw.trim();
    const keyed = SECRET_KEY.test(key) && value.length >= MIN_KEYED_LENGTH;
    if (!keyed && !looksSecret(value)) continue;
    const lower = value.toLowerCase();
    if (skip.has(lower) || COMMON_WORDS.has(lower)) continue;
    out.add(value);
  }
  return [...out];
}

export { MIN_KEYED_LENGTH };
