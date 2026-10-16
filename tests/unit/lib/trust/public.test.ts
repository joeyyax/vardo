import { describe, expect, it } from "vitest";
import { checkedAgo, toPublic, type PublicInput } from "@/lib/trust/public";
import { manualHosting } from "@/lib/trust/hosting";
import type { CheckId, CheckResult, CheckState } from "@/lib/trust/types";

const NOW = new Date("2026-10-16T12:00:00Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);

function result(id: CheckId, state: CheckState, minutesAgo = 5): CheckResult {
  return { id, state, evidence: `secret evidence for ${id}`, checkedAt: at(minutesAgo) };
}

function input(over: Partial<PublicInput> = {}): PublicInput {
  return {
    name: "Acme",
    securityContact: "security@acme.example",
    hosting: null,
    results: [],
    commitments: [],
    subprocessors: [],
    policies: [],
    dpa: null,
    ...over,
  };
}

describe("toPublic controls", () => {
  it("lists passing checks as outcomes and drops everything else", () => {
    const t = toPublic(
      input({
        results: [
          result("nightly-backups", "passing"),
          result("https", "failing"),
          result("two-step", "partial"),
          result("probe-guard", "unknown"),
          result("vardo-updated", "passing"),
        ],
      }),
    );
    const outcomes = t.controls.flatMap((g) => g.items.map((i) => i.outcome));
    expect(outcomes).toEqual(["Nightly backups completing", "Platform up to date"]);
  });

  it("never carries evidence, ids or a score", () => {
    const json = JSON.stringify(toPublic(input({ results: [result("nightly-backups", "passing")] })));
    expect(json).not.toContain("secret evidence");
    expect(json).not.toContain("nightly-backups");
    expect(json).not.toMatch(/score|band|weight/i);
  });

  it("omits a group with no passing checks", () => {
    const t = toPublic(input({ results: [result("two-step", "failing"), result("nightly-backups", "passing")] }));
    expect(t.controls.map((g) => g.group)).toEqual(["Data protection"]);
  });

  it("carries the check time so freshness is honest", () => {
    const t = toPublic(input({ results: [result("nightly-backups", "passing", 120)] }));
    expect(checkedAgo(t.controls[0].items[0].checkedAt, NOW)).toBe("checked 2 hours ago");
  });
});

describe("toPublic hosting", () => {
  it("lists the certificate only when it covers the location", () => {
    const covered = toPublic(input({ hosting: manualHosting({ provider: "hetzner", region: "nbg1" }) }));
    expect(covered.hosting?.certification?.standard).toBe("ISO/IEC 27001");
    const uncovered = toPublic(input({ hosting: manualHosting({ provider: "hetzner", region: "hil-dc1" }) }));
    expect(uncovered.hosting?.provider).toBe("Hetzner Online");
    expect(uncovered.hosting?.location).toBe("Hillsboro, Oregon");
    expect(uncovered.hosting?.certification).toBeNull();
  });

  it("lists no certificate for a provider it can't judge", () => {
    expect(toPublic(input({ hosting: manualHosting({ provider: "Acme Cloud", region: "x" }) })).hosting?.certification).toBeNull();
  });
});

describe("toPublic approval", () => {
  it("shows only confirmed subprocessors", () => {
    const t = toPublic(
      input({
        subprocessors: [
          { name: "Confirmed Co", purpose: "Email", region: "US", status: "confirmed" },
          { name: "Suggested Co", purpose: "Backups", region: null, status: "suggested" },
          { name: "Dismissed Co", purpose: "DNS", region: null, status: "dismissed" },
        ],
      }),
    );
    expect(t.subprocessors).toEqual([{ name: "Confirmed Co", purpose: "Email", region: "US" }]);
  });

  it("shows only commitments that are on and have a value", () => {
    const t = toPublic(
      input({
        commitments: [
          { label: "Uptime", value: "99.9%", enabled: true },
          { label: "Support response", value: "4 hours", enabled: false },
          { label: "Recovery time", value: null, enabled: true },
        ],
      }),
    );
    expect(t.commitments).toEqual([{ label: "Uptime", value: "99.9%" }]);
  });

  it("shows the last reviewed text of a policy, never an unreviewed one", () => {
    const t = toPublic(
      input({
        policies: [
          { id: "backup", title: "Backup policy", reviewedBody: "Reviewed text", reviewedAt: at(1000) },
          { id: "access", title: "Access policy", reviewedBody: null, reviewedAt: null },
          { id: "incident", title: "Incident policy", reviewedBody: "Orphaned text", reviewedAt: null },
        ],
      }),
    );
    expect(t.policies.map((p) => [p.id, p.body])).toEqual([["backup", "Reviewed text"]]);
  });

  it("shows the agreement only with a file and a review", () => {
    expect(toPublic(input({ dpa: { hasFile: true, reviewedAt: null } })).dpa).toBeNull();
    expect(toPublic(input({ dpa: { hasFile: false, reviewedAt: at(1) } })).dpa).toBeNull();
    expect(toPublic(input({ dpa: { hasFile: true, reviewedAt: at(1) } })).dpa).not.toBeNull();
  });

  it("drops a security contact that isn't an email address", () => {
    expect(toPublic(input({ securityContact: "<script>" })).securityContact).toBeNull();
    expect(toPublic(input()).securityContact).toBe("security@acme.example");
  });
});

describe("checkedAgo", () => {
  it("rounds down to the largest unit", () => {
    expect(checkedAgo(at(0), NOW)).toBe("checked just now");
    expect(checkedAgo(at(1), NOW)).toBe("checked 1 minute ago");
    expect(checkedAgo(at(59), NOW)).toBe("checked 59 minutes ago");
    expect(checkedAgo(at(60), NOW)).toBe("checked 1 hour ago");
    expect(checkedAgo(at(60 * 49), NOW)).toBe("checked 2 days ago");
  });
});
