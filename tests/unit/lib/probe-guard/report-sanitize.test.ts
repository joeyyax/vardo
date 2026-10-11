import { describe, expect, it } from "vitest";
import { sanitizeReportPath, sensitiveTerms } from "@/lib/probe-guard/reporting/sanitize";
import { draftReport } from "@/lib/probe-guard/reporting/draft";

const terms = sensitiveTerms({
  hosts: ["console.example.com", "shop.example.net", "*.apps.example.org"],
  names: ["Acme Storefront", "acme-store", "Northwind Labs", "northwind"],
});

const HOSTILE = [
  "/console.example.com/.env",
  "/backup/example.com.sql",
  "/shop.example.net.zip",
  "/example/.env",
  "/acme-store/.git/config",
  "/northwind_backup.sql",
  "/Storefront/.env",
  "/.env?token=sk_live_abcdefghijklmnop1234&email=owner@example.com",
  "/download#owner@example.com",
  "/users/owner@example.com/.ssh/id_rsa",
  "/admin%40example.com/.env",
  "/%63onsole.example.com/.env",
  "https://console.example.com/.env?x=1",
  "//evil.example.io/.env",
  "/203.0.113.9/.env",
  "/api/9f8e7d6c5b4a39281706f5e4d3c2b1a0/.env",
  "/v1/AKIAABCDEFGHIJKLMNOP/.aws/credentials",
  "/files/www.other-site.co.uk/.env",
  "/x.apps.example.org/.env",
];

const LEAKS = [
  /example\.(com|net|org|io)/i,
  /console/i,
  /shop/i,
  /acme/i,
  /northwind/i,
  /storefront/i,
  /@/,
  /\?/,
  /#/,
  /token|sk_live|email/i,
  /203\.0\.113\.9/,
  /9f8e7d6c5b4a/,
  /AKIA/,
  /other-site/,
  /https?:/,
];

describe("sanitizeReportPath", () => {
  it.each(HOSTILE)("leaks nothing from %s", (path) => {
    const out = sanitizeReportPath(path, terms);
    for (const leak of LEAKS) expect(out).not.toMatch(leak);
    expect(out.startsWith("/")).toBe(true);
  });

  it("keeps ordinary probe paths readable", () => {
    expect(sanitizeReportPath("/_ignition/execute-solution", terms)).toBe("/_ignition/execute-solution");
    expect(sanitizeReportPath("/.env", terms)).toBe("/.env");
    expect(sanitizeReportPath("/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php", terms)).toBe("/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php");
    expect(sanitizeReportPath("/wp-config.php.bak", terms)).toBe("/wp-config.php.bak");
    expect(sanitizeReportPath("/../../etc/passwd", terms)).toBe("/../../etc/passwd");
    expect(sanitizeReportPath("/windows/win.ini", terms)).toBe("/windows/win.ini");
  });

  it("drops the query and fragment", () => {
    expect(sanitizeReportPath("/.env?debug=1#top")).toBe("/.env");
  });

  it("redacts host-looking segments with no known terms", () => {
    expect(sanitizeReportPath("/www.example.com/.env")).toBe("/*/.env");
    expect(sanitizeReportPath("/backup/site.example.co.uk/db.sql")).toBe("/backup/*/db.sql");
  });
});

describe("report comments", () => {
  it("never carry the instance's names, hosts or query values", () => {
    const now = new Date("2026-03-01T12:00:00Z");
    const events = HOSTILE.map((path) => ({ ip: "198.51.100.20", kind: "probe", path, createdAt: now }));
    const report = draftReport({
      ip: "198.51.100.20",
      ban: { reason: "threshold", createdAt: now },
      events: [...events, { ip: "198.51.100.20", kind: "probe", path: "/_ignition/execute-solution?host=console.example.com", createdAt: now }],
      windowMs: 600_000,
      now,
      terms,
    });
    expect(report).not.toBeNull();
    for (const leak of LEAKS) expect(report!.comment).not.toMatch(leak);
  });
});
