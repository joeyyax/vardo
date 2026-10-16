import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/trust/policy-facts", () => ({ readPolicyFacts: async () => ({}) }));

import { policyReviews, policyViews } from "@/lib/trust/documents";
import { basisHash, generatePolicy, list, reviewState, type PolicyFacts } from "@/lib/trust/policies";
import { toPublic } from "@/lib/trust/public";

const facts: PolicyFacts = {
  name: "Acme",
  backup: { jobs: true, recoveryPointHours: 24, retentionDays: 30, offHost: true, encrypted: true },
  access: { methods: ["passkey", "password", "totp"], registration: "closed", sessionDays: 7 },
  incident: { securityContact: "security@acme.example", breachNotification: "Within 72 hours", email: true, backupFailureAlerts: true },
};

describe("generatePolicy", () => {
  it("describes the backup settings and nothing else", () => {
    const text = generatePolicy("backup", facts);
    expect(text).toContain("The longest gap between runs is 24 hours.");
    expect(text).toContain("Backups are kept for 30 days");
    expect(text).toContain("encrypted before they're stored");
    expect(text).toContain("off the host");
  });

  it("leaves out a claim the settings don't support", () => {
    const text = generatePolicy("backup", { ...facts, backup: { ...facts.backup, encrypted: false, offHost: false, retentionDays: null } });
    expect(text).not.toContain("encrypted");
    expect(text).not.toContain("off the host");
    expect(text).not.toContain("Retention");
  });

  it("says so when no backup job is enabled", () => {
    expect(generatePolicy("backup", { ...facts, backup: { ...facts.backup, jobs: false } })).toContain("No backup jobs are enabled.");
  });

  it("lists the sign-in methods that are on", () => {
    const text = generatePolicy("access", facts);
    expect(text).toContain("People sign in with a passkey, a password and an authenticator app.");
    expect(text).toContain("two-step sign-in");
    expect(text).toContain("New accounts are created by invitation.");
    expect(generatePolicy("access", { ...facts, access: { ...facts.access, methods: ["password"] } })).not.toContain("two-step");
  });

  it("quotes the operator's own breach commitment only when it's on", () => {
    expect(generatePolicy("incident", facts)).toContain("Acme's breach notification commitment: within 72 hours.");
    expect(generatePolicy("incident", { ...facts, incident: { ...facts.incident, breachNotification: null } })).not.toContain("Breach notification");
  });

  it("never makes a promise", () => {
    for (const id of ["backup", "access", "incident"] as const) {
      expect(generatePolicy(id, facts)).not.toMatch(/\b(guarantee|promise|ensure|always|never|will)\b/i);
    }
  });
});

describe("list", () => {
  it("joins without an Oxford comma", () => {
    expect(list(["a", "b", "c"])).toBe("a, b and c");
    expect(list(["a", "b"])).toBe("a and b");
    expect(list(["a"])).toBe("a");
  });
});

describe("review state", () => {
  const reviewed = { reviewedAt: new Date("2026-10-01"), basisHash: basisHash("backup", facts), reviewedBody: "Reviewed text." };

  it("is a draft until reviewed", () => {
    expect(reviewState(null, basisHash("backup", facts))).toBe("draft");
    expect(reviewState({ reviewedAt: null, basisHash: null }, basisHash("backup", facts))).toBe("draft");
  });

  it("is reviewed while the settings behind it hold", () => {
    expect(reviewState(reviewed, basisHash("backup", facts))).toBe("reviewed");
  });

  it("goes back to review when a setting behind it changes, and not for an unrelated one", () => {
    const changed = { ...facts, backup: { ...facts.backup, retentionDays: 14 } };
    expect(reviewState(reviewed, basisHash("backup", changed))).toBe("review");
    const unrelated = { ...facts, access: { ...facts.access, sessionDays: 30 } };
    expect(reviewState(reviewed, basisHash("backup", unrelated))).toBe("reviewed");
  });

  it("keeps the last reviewed text on the public page after the settings change", () => {
    const changed = { ...facts, backup: { ...facts.backup, retentionDays: 14 } };
    const views = policyViews(changed, new Map([["backup", reviewed]]));
    const backup = views.find((v) => v.id === "backup")!;
    expect(backup.state).toBe("review");
    expect(backup.published).toBe("Reviewed text.");
    expect(backup.draft).toContain("14 days");

    const pub = toPublic({
      name: "Acme",
      domain: "acme.example",
      securityContact: null,
      hosting: null,
      results: [],
      commitments: [],
      subprocessors: [],
      policies: [{ id: "backup", title: "Backup", reviewedBody: reviewed.reviewedBody, reviewedAt: reviewed.reviewedAt }],
      dpa: null,
    });
    expect(pub.policies[0].body).toBe("Reviewed text.");
  });

  it("asks for review of a draft and of a stale policy, not a current one", () => {
    const views = policyViews(facts, new Map([["backup", reviewed], ["access", { ...reviewed, basisHash: "old" }]]));
    expect(policyReviews(views).map((r) => r.id)).toEqual(["policy-access", "policy-incident"]);
  });
});
