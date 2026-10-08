import { describe, it, expect } from "vitest";
import { diagnoseCert, diagnoseDns, dnsFactsFromCheck, worstTone } from "@/components/ssl/domain-diagnosis";

const now = Date.parse("2026-10-08T00:00:00Z");
const day = 24 * 60 * 60 * 1000;

describe("dnsFactsFromCheck + diagnoseDns", () => {
  it("reads a configured domain as connected", () => {
    const d = diagnoseDns(dnsFactsFromCheck({ status: "configured", resolves: true, configured: true, records: { a: ["1.2.3.4"] } }));
    expect(d.state).toBe("connected");
  });

  it("tells wrong IP from no records", () => {
    const wrong = diagnoseDns(
      dnsFactsFromCheck({ status: "wrong-target", resolves: true, configured: false, reachable: false, serverIp: "9.9.9.9", records: { a: ["1.2.3.4"] } }),
    );
    expect(wrong.state).toBe("not-responding");
    const wrongIp = diagnoseDns(
      dnsFactsFromCheck({ status: "wrong-target", resolves: true, configured: false, reachable: true, serverIp: "9.9.9.9", records: { a: ["1.2.3.4"] } }),
    );
    expect(wrongIp.state).toBe("wrong-ip");
    expect(wrongIp.hint).toContain("9.9.9.9");
    expect(diagnoseDns(dnsFactsFromCheck({ status: "no-records", resolves: false, configured: false })).state).toBe("no-records");
  });

  it("names the Cloudflare proxy", () => {
    const d = diagnoseDns(dnsFactsFromCheck({ status: "configured", resolves: true, configured: true, proxied: true, proxyProvider: "cloudflare", records: { a: ["104.16.0.1"] } }));
    expect(d.label).toBe("Connected (via Cloudflare)");
  });

  it("keeps a failed lookup apart from missing records", () => {
    expect(diagnoseDns(dnsFactsFromCheck({ status: "error" })).state).toBe("error");
  });
});

describe("diagnoseCert", () => {
  const at = (days: number) => new Date(now + days * day).toISOString();

  it("covers every stored state", () => {
    expect(diagnoseCert(null, now).state).toBe("unchecked");
    expect(diagnoseCert({ status: "not-issued", expiresAt: null, checkedAt: at(0) }, now).state).toBe("not-issued");
    expect(diagnoseCert({ status: "unknown", expiresAt: null, checkedAt: at(0) }, now).state).toBe("unknown");
    expect(diagnoseCert({ status: "ok", expiresAt: at(60), checkedAt: at(0) }, now).state).toBe("ok");
    expect(diagnoseCert({ status: "expiring", expiresAt: at(3), checkedAt: at(0) }, now).state).toBe("expiring");
    expect(diagnoseCert({ status: "expired", expiresAt: at(-1), checkedAt: at(0) }, now).state).toBe("expired");
  });

  it("trusts the date over a stale status", () => {
    expect(diagnoseCert({ status: "ok", expiresAt: at(-2), checkedAt: at(-10) }, now).state).toBe("expired");
  });
});

describe("worstTone", () => {
  it("picks the most urgent", () => {
    expect(worstTone("success", "warning")).toBe("warning");
    expect(worstTone("success", "error", "warning")).toBe("error");
  });
});
