import { describe, it, expect } from "vitest";
import {
  parseCertNotAfter,
  evaluateCertExpiry,
  certVerdictAlerts,
  certAlertMessage,
  CERT_EXPIRY_THRESHOLD_DAYS,
  type CertProbe,
} from "@/lib/system-alerts/cert-expiry";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** An authorized handshake whose cert expires `days` from NOW. */
function probe(days: number, overrides: Partial<Extract<CertProbe, { status: "ok" }>> = {}): CertProbe {
  return {
    status: "ok",
    validTo: new Date(NOW + days * DAY).toUTCString(),
    authorized: true,
    authorizationError: null,
    ...overrides,
  };
}

describe("parseCertNotAfter", () => {
  it("parses OpenSSL's notAfter format", () => {
    expect(parseCertNotAfter("Aug 12 09:14:22 2026 GMT")).toBe(
      Date.parse("2026-08-12T09:14:22.000Z"),
    );
  });

  it("parses ISO 8601", () => {
    expect(parseCertNotAfter("2026-08-12T09:14:22.000Z")).toBe(
      Date.parse("2026-08-12T09:14:22.000Z"),
    );
  });

  it("returns null for malformed input", () => {
    expect(parseCertNotAfter("not a date")).toBeNull();
    expect(parseCertNotAfter("")).toBeNull();
    expect(parseCertNotAfter("   ")).toBeNull();
    expect(parseCertNotAfter(undefined)).toBeNull();
    expect(parseCertNotAfter(null)).toBeNull();
    expect(parseCertNotAfter(1786000000000)).toBeNull();
    expect(parseCertNotAfter({ valid_to: "Aug 12 2026" })).toBeNull();
  });

  it("rejects dates outside a plausible certificate range", () => {
    expect(parseCertNotAfter("Jan 1 00:00:00 1970 GMT")).toBeNull();
    expect(parseCertNotAfter("Jan 1 00:00:00 3000 GMT")).toBeNull();
  });
});

describe("evaluateCertExpiry", () => {
  it("reports a comfortably valid certificate as ok", () => {
    const verdict = evaluateCertExpiry(probe(60), NOW);
    expect(verdict.kind).toBe("ok");
    expect(verdict).toMatchObject({ daysLeft: 60 });
    expect(certVerdictAlerts(verdict)).toBe(false);
  });

  it("reports a certificate inside the threshold as expiring", () => {
    const verdict = evaluateCertExpiry(probe(5), NOW);
    expect(verdict).toMatchObject({ kind: "expiring", severity: "warning", daysLeft: 5 });
    expect(certVerdictAlerts(verdict)).toBe(true);
  });

  it("escalates to critical inside two days", () => {
    expect(evaluateCertExpiry(probe(2), NOW)).toMatchObject({
      kind: "expiring",
      severity: "critical",
    });
    expect(evaluateCertExpiry(probe(3), NOW)).toMatchObject({
      kind: "expiring",
      severity: "warning",
    });
  });

  it("treats the threshold boundary as expiring and one day past it as ok", () => {
    expect(evaluateCertExpiry(probe(CERT_EXPIRY_THRESHOLD_DAYS), NOW).kind).toBe("expiring");
    expect(evaluateCertExpiry(probe(CERT_EXPIRY_THRESHOLD_DAYS + 1), NOW).kind).toBe("ok");
  });

  it("honors a caller-supplied threshold", () => {
    expect(evaluateCertExpiry(probe(20), NOW, 30).kind).toBe("expiring");
  });

  it("reports an expired certificate as critical with negative daysLeft", () => {
    const verdict = evaluateCertExpiry(probe(-3), NOW);
    expect(verdict).toMatchObject({ kind: "expired", severity: "critical", daysLeft: -3 });
    expect(certVerdictAlerts(verdict)).toBe(true);
  });

  it("still reports expiry when the chain failed verification because it expired", () => {
    const verdict = evaluateCertExpiry(
      probe(-1, { authorized: false, authorizationError: "CERT_HAS_EXPIRED" }),
      NOW,
    );
    expect(verdict.kind).toBe("expired");
  });

  it("reports a self-signed cert as not-issued rather than alerting", () => {
    const verdict = evaluateCertExpiry(
      probe(365, { authorized: false, authorizationError: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      NOW,
    );
    expect(verdict).toMatchObject({ kind: "not-issued", reason: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect(certVerdictAlerts(verdict)).toBe(false);
  });

  it("reports an unreachable domain as unknown rather than alerting", () => {
    const verdict = evaluateCertExpiry({ status: "unreachable", reason: "ECONNREFUSED" }, NOW);
    expect(verdict).toMatchObject({ kind: "unknown", reason: "ECONNREFUSED" });
    expect(certVerdictAlerts(verdict)).toBe(false);
  });

  it("reports a malformed notAfter as unknown rather than alerting", () => {
    for (const validTo of ["", "garbage", undefined, 0]) {
      const verdict = evaluateCertExpiry(probe(30, { validTo }), NOW);
      expect(verdict).toMatchObject({ kind: "unknown", reason: "unreadable notAfter" });
      expect(certVerdictAlerts(verdict)).toBe(false);
    }
  });

  it("does not swallow an unrecognized verification failure", () => {
    const verdict = evaluateCertExpiry(
      probe(30, { authorized: false, authorizationError: "ERR_TLS_CERT_ALTNAME_INVALID" }),
      NOW,
    );
    expect(verdict.kind).toBe("ok");
  });
});

describe("certAlertMessage", () => {
  it("singularizes one day", () => {
    const verdict = evaluateCertExpiry(probe(1), NOW);
    if (!certVerdictAlerts(verdict)) throw new Error("expected an alerting verdict");
    const { title, message } = certAlertMessage("app.example.com", verdict);
    expect(title).toBe("Certificate expiring: app.example.com");
    expect(message).toContain("expires in 1 day.");
  });

  it("reads in the past tense once expired", () => {
    const verdict = evaluateCertExpiry(probe(-2), NOW);
    if (!certVerdictAlerts(verdict)) throw new Error("expected an alerting verdict");
    const { title, message } = certAlertMessage("app.example.com", verdict);
    expect(title).toBe("Certificate expired: app.example.com");
    expect(message).toContain("expired 2 days ago");
  });
});
