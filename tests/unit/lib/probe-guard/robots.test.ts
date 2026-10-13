import { describe, expect, it } from "vitest";
import { renderAppRobots, renderConsoleRobots, renderSecurityTxt } from "@/lib/probe-guard/robots";
import { DEFAULT_INSTANCE_PROBE_GUARD as S } from "@/lib/probe-guard/settings";

describe("robots.txt", () => {
  it("keeps the console closed except sign-in and invites, plus trap lines", () => {
    expect(renderConsoleRobots(S)).toBe(
      [
        "User-agent: *",
        "Allow: /login",
        "Allow: /invite/",
        "Disallow: /",
        "Disallow: /admin-backup/",
        "Disallow: /.old/",
        "Disallow: /private/db.sql",
        "",
      ].join("\n"),
    );
  });

  it("leaves an app open but the traps", () => {
    const body = renderAppRobots(S);
    expect(body).toContain("Allow: /\n");
    expect(body).toContain("Disallow: /.old/\n");
    expect(body).not.toContain("Disallow: /\n");
  });

  it("drops the traps with traps off", () => {
    const body = renderAppRobots({ traps: { ...S.traps, enabled: false } });
    expect(body).toBe("User-agent: *\nAllow: /\n");
  });
});

describe("security.txt", () => {
  const now = new Date("2026-03-01T12:00:00Z");

  it("names the contact, expires within a year and links itself", () => {
    const body = renderSecurityTxt("security@example.com", { canonical: "https://console.example.com/.well-known/security.txt", now })!;
    expect(body).toContain("Contact: mailto:security@example.com\n");
    expect(body).toContain("Expires: 2027-03-01T00:00:00Z\n");
    expect(body).toContain("Canonical: https://console.example.com/.well-known/security.txt\n");
    expect(body.startsWith("Contact: mailto:security@example.com\n")).toBe(true);
  });

  it("has no comment and nothing without a contact", () => {
    expect(renderSecurityTxt("a@example.com", { now })!.startsWith("Contact:")).toBe(true);
    expect(renderSecurityTxt("", { now })).toBeNull();
  });
});
