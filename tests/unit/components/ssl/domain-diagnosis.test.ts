import { describe, it, expect } from "vitest";
import { diagnoseCert, diagnoseDns, dnsFactsFromCheck, worstTone } from "@/components/ssl/domain-diagnosis";

const now = Date.parse("2026-10-08T00:00:00Z");
const day = 24 * 60 * 60 * 1000;

describe("dnsFactsFromCheck + diagnoseDns", () => {
  const diagnose = (data: Parameters<typeof dnsFactsFromCheck>[0]) => diagnoseDns(dnsFactsFromCheck(data));

  it("reads a verified domain as connected", () => {
    const d = diagnose({ status: "configured", resolves: true, configured: true, verified: true, records: { a: ["198.51.100.4"] } });
    expect(d.state).toBe("connected");
    expect(d.hint).toBeUndefined();
  });

  it("says when only the records vouch for it", () => {
    const d = diagnose({ status: "configured", resolves: true, configured: true, verified: false, records: { a: ["192.0.2.10"] } });
    expect(d.state).toBe("connected");
    expect(d.hint).toContain("couldn't reach");
  });

  it("names the proxy from the check", () => {
    const cf = diagnose({ status: "configured", resolves: true, configured: true, verified: true, proxied: true, proxyProvider: "cloudflare" });
    expect(cf.label).toBe("Connected (via Cloudflare)");
    expect(cf.hint).toContain("nested subdomains");
    const other = diagnose({ status: "configured", resolves: true, configured: true, verified: true, proxied: true, proxyProvider: "proxy" });
    expect(other.state).toBe("proxied");
    expect(other.label).toBe("Connected (via proxy)");
    expect(other.hint).toBeUndefined();
  });

  it("calls a domain answered by someone else another server", () => {
    const d = diagnose({ status: "wrong-target", resolves: true, configured: false, reachable: true, serverIp: "192.0.2.10", records: { a: ["198.51.100.4"] } });
    expect(d).toMatchObject({ state: "other-server", label: "Reaches another server", tone: "error" });
    expect(d.hint).toContain("198.51.100.4");
    expect(d.hint).toContain("192.0.2.10");
    const proxied = diagnose({ status: "wrong-target", resolves: true, configured: false, reachable: true, proxyProvider: "cloudflare", records: { a: ["198.51.100.4"] } });
    expect(proxied.hint).toContain("through Cloudflare");
  });

  it("tells silence from missing records", () => {
    const silent = diagnose({ status: "not-responding", resolves: true, configured: false, reachable: false, records: { a: ["198.51.100.4"] } });
    expect(silent.state).toBe("not-responding");
    expect(silent.hint).toContain("198.51.100.4");
    const origin = diagnose({ status: "not-responding", resolves: true, configured: false, reachable: false, proxyProvider: "cloudflare" });
    expect(origin.hint).toContain("Cloudflare answers");
    expect(diagnose({ status: "no-records", resolves: false, configured: false }).state).toBe("no-records");
  });

  it("keeps a failed lookup apart from missing records", () => {
    expect(diagnose({ status: "error" }).state).toBe("error");
  });

  it("reads the admin check shape directly", () => {
    expect(diagnoseDns({ resolved: true, ips: ["198.51.100.4"], matches: false, reachable: true }).state).toBe("other-server");
    expect(diagnoseDns({ resolved: true, ips: ["198.51.100.4"], matches: false, failed: true }).state).toBe("error");
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
