import { describe, it, expect } from "vitest";
import {
  describeRule,
  expiryFor,
  indexRules,
  isActive,
  silencedBy,
  silences,
  targets,
  type IgnoreCandidate,
  type IgnoreRule,
} from "@/lib/docker/image-updates/ignore";

const NOW = Date.parse("2026-08-01T12:00:00Z");
const DAY = 86_400_000;

function rule(over: Partial<IgnoreRule> = {}): IgnoreRule {
  return {
    id: "r1",
    appId: "app1",
    composeService: "postgres",
    scope: "all",
    expiresAt: null,
    ...over,
  };
}

function candidate(over: Partial<IgnoreCandidate> = {}): IgnoreCandidate {
  return { appId: "app1", service: "postgres", severity: "minor", ...over };
}

describe("targets", () => {
  it("matches only the app and service it names", () => {
    expect(targets(rule(), candidate())).toBe(true);
    expect(targets(rule(), candidate({ appId: "app2" }))).toBe(false);
    expect(targets(rule(), candidate({ service: "redis" }))).toBe(false);
  });

  it("treats a single-image app as the null service", () => {
    expect(targets(rule({ composeService: null }), candidate({ service: null }))).toBe(true);
    expect(targets(rule({ composeService: null }), candidate({ service: "redis" }))).toBe(false);
  });
});

describe("isActive", () => {
  it("never lapses without an expiry", () => {
    expect(isActive(rule(), NOW)).toBe(true);
  });

  it("is active right up to the expiry and lapsed on it", () => {
    const expiresAt = new Date(NOW + 1000).toISOString();
    expect(isActive(rule({ expiresAt }), NOW)).toBe(true);
    expect(isActive(rule({ expiresAt }), NOW + 999)).toBe(true);
    expect(isActive(rule({ expiresAt }), NOW + 1000)).toBe(false);
    expect(isActive(rule({ expiresAt }), NOW + 1001)).toBe(false);
  });

  it("keeps the rule rather than dropping it when the timestamp is unreadable", () => {
    expect(isActive(rule({ expiresAt: "not a date" }), NOW)).toBe(true);
  });
});

describe("silences", () => {
  it("hides everything under scope all", () => {
    for (const severity of ["patch", "minor", "major", "build", "unknown"] as const) {
      expect(silences(rule(), candidate({ severity }), NOW), severity).toBe(true);
    }
  });

  it("hides only majors under scope major", () => {
    const majorOnly = rule({ scope: "major" });
    expect(silences(majorOnly, candidate({ severity: "major" }), NOW)).toBe(true);
    expect(silences(majorOnly, candidate({ severity: "minor" }), NOW)).toBe(false);
    expect(silences(majorOnly, candidate({ severity: "patch" }), NOW)).toBe(false);
    expect(silences(majorOnly, candidate({ severity: null }), NOW)).toBe(false);
  });

  it("stops hiding the moment the rule lapses", () => {
    const expiring = rule({ expiresAt: new Date(NOW + DAY).toISOString() });
    expect(silences(expiring, candidate(), NOW)).toBe(true);
    expect(silences(expiring, candidate(), NOW + DAY)).toBe(false);
  });

  it("hides nothing on another app", () => {
    expect(silences(rule(), candidate({ appId: "app2" }), NOW)).toBe(false);
  });
});

describe("silencedBy", () => {
  it("silences one service without touching its siblings", () => {
    const index = indexRules([rule({ composeService: "postgres" })]);
    expect(silencedBy(index, candidate({ service: "postgres" }), NOW)).not.toBeNull();
    expect(silencedBy(index, candidate({ service: "redis" }), NOW)).toBeNull();
  });

  it("returns the rule so the caller can explain and undo it", () => {
    const index = indexRules([rule({ id: "keepme" })]);
    expect(silencedBy(index, candidate(), NOW)?.id).toBe("keepme");
  });

  it("returns null once the rule has lapsed, without needing a sweep", () => {
    const index = indexRules([rule({ expiresAt: new Date(NOW - 1).toISOString() })]);
    expect(silencedBy(index, candidate(), NOW)).toBeNull();
  });
});

describe("expiryFor", () => {
  it("is null for a permanent ignore", () => {
    expect(expiryFor(null, NOW)).toBeNull();
  });

  it("lands the requested number of days out", () => {
    expect(expiryFor(30, NOW)!.toISOString()).toBe(new Date(NOW + 30 * DAY).toISOString());
  });
});

describe("describeRule", () => {
  it("names the scope and that it never lapses", () => {
    expect(describeRule(rule(), NOW)).toBe("All updates hidden, permanently");
    expect(describeRule(rule({ scope: "major" }), NOW)).toBe("Majors hidden, permanently");
  });

  it("counts the days left", () => {
    const r = rule({ expiresAt: new Date(NOW + 3 * DAY).toISOString() });
    expect(describeRule(r, NOW)).toBe("All updates hidden, 3 days left");
  });

  it("says today rather than 0 days on the last day", () => {
    const r = rule({ expiresAt: new Date(NOW).toISOString() });
    expect(describeRule(r, NOW)).toBe("All updates hidden, lapsing today");
  });
});
