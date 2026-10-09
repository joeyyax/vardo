// Certificate expiry verdicts from a TLS handshake observation. Pure.

/** Days remaining at or below which a certificate raises an alert. Traefik renews at 30, so this leaves nine days of retries. */
export const CERT_EXPIRY_THRESHOLD_DAYS = 21;

/** Days remaining at or below which the alert is critical. */
export const CERT_EXPIRY_CRITICAL_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Verification failures meaning no certificate has been issued yet.
 * Keep CERT_HAS_EXPIRED out; an expired cert must reach the expiry math.
 */
const NOT_ISSUED_ERRORS = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

/** What one TLS handshake observed. */
export type CertProbe =
  | {
      status: "ok";
      /** The peer certificate's notAfter, as Node reports it. Unvalidated. */
      validTo: unknown;
      /** SHA-256 of the peer certificate. Identifies domains sharing one cert. */
      fingerprint: string | null;
      authorized: boolean;
      authorizationError: string | null;
    }
  | { status: "unreachable"; reason: string };

export type CertVerdict =
  | { kind: "ok"; daysLeft: number; expiresAt: string }
  | { kind: "expiring"; severity: "warning" | "critical"; daysLeft: number; expiresAt: string }
  | { kind: "expired"; severity: "critical"; daysLeft: number; expiresAt: string }
  | { kind: "not-issued"; reason: string }
  | { kind: "unknown"; reason: string };

/** Parses a notAfter (OpenSSL or ISO 8601 format) into epoch ms, or null. */
export function parseCertNotAfter(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const year = new Date(parsed).getUTCFullYear();
  if (year < 1990 || year > 2200) return null;
  return parsed;
}

/**
 * Turns a probe result into a verdict.
 * @param probe          the handshake observation
 * @param now            current epoch ms
 * @param thresholdDays  days remaining at which to start alerting
 */
export function evaluateCertExpiry(
  probe: CertProbe,
  now: number,
  thresholdDays: number = CERT_EXPIRY_THRESHOLD_DAYS,
): CertVerdict {
  if (probe.status === "unreachable") {
    return { kind: "unknown", reason: probe.reason };
  }

  if (!probe.authorized && probe.authorizationError !== null) {
    if (NOT_ISSUED_ERRORS.has(probe.authorizationError)) {
      return { kind: "not-issued", reason: probe.authorizationError };
    }
  }

  const notAfter = parseCertNotAfter(probe.validTo);
  if (notAfter === null) {
    return { kind: "unknown", reason: "unreadable notAfter" };
  }

  const expiresAt = new Date(notAfter).toISOString();
  const daysLeft = Math.floor((notAfter - now) / MS_PER_DAY);

  if (notAfter <= now) {
    return { kind: "expired", severity: "critical", daysLeft, expiresAt };
  }

  if (daysLeft <= thresholdDays) {
    return {
      kind: "expiring",
      severity: daysLeft <= CERT_EXPIRY_CRITICAL_DAYS ? "critical" : "warning",
      daysLeft,
      expiresAt,
    };
  }

  return { kind: "ok", daysLeft, expiresAt };
}

/** Whether a verdict warrants firing an alert. */
export function certVerdictAlerts(
  verdict: CertVerdict,
): verdict is Extract<CertVerdict, { kind: "expiring" | "expired" }> {
  return verdict.kind === "expiring" || verdict.kind === "expired";
}

/** "example.com" / "example.com and 41 other domains" */
function subject(domains: string[]): string {
  const [first, ...rest] = domains;
  if (rest.length === 0) return first;
  return `${first} and ${rest.length} other domain${rest.length === 1 ? "" : "s"}`;
}

/** Alert copy for a firing verdict, covering every domain the certificate serves. */
export function certAlertMessage(
  domains: string[],
  verdict: Extract<CertVerdict, { kind: "expiring" | "expired" }>,
): { title: string; message: string } {
  const who = subject(domains);
  if (verdict.kind === "expired") {
    const days = Math.abs(verdict.daysLeft);
    return {
      title: `Certificate expired: ${who}`,
      message: `The TLS certificate for ${who} expired ${days} day${days === 1 ? "" : "s"} ago. Browsers are refusing the connection — check Traefik's ACME logs.`,
    };
  }
  return {
    title: `Certificate expiring: ${who}`,
    message: `The TLS certificate for ${who} expires in ${verdict.daysLeft} day${verdict.daysLeft === 1 ? "" : "s"}. Traefik should auto-renew — check its logs if renewal is not happening.`,
  };
}

/** Groups domains by certificate. Domains without a fingerprint are keyed by name. */
export function groupByCertificate<T extends { domain: string; fingerprint: string | null }>(
  entries: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const key = entry.fingerprint ?? `domain:${entry.domain}`;
    const existing = groups.get(key);
    if (existing) existing.push(entry);
    else groups.set(key, [entry]);
  }
  return groups;
}
