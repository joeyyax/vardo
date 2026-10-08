// Domain ownership rules (#891).

import { describe, it, expect, vi } from "vitest";
import {
  challengeName,
  checkChallenge,
  consoleHostsFrom,
  isRoutable,
  needsChallenge,
  refusedHost,
  verificationView,
} from "@/lib/domains/ownership";

const inst = { base: "vardo.test", console: ["console.vardo.test", "vardo.example.com"] };
const untrusted = { trusted: false };
const trusted = { trusted: true };

describe("refusedHost", () => {
  it("refuses the console host and the instance base domain", () => {
    expect(refusedHost("console.vardo.test", inst)).toMatch(/console's own host/);
    expect(refusedHost("VARDO.EXAMPLE.COM", inst)).toMatch(/console's own host/);
    expect(refusedHost("vardo.test", inst)).toMatch(/instance base domain/);
  });

  it("leaves subdomains of the instance base to the app-name rules", () => {
    expect(refusedHost("blog.vardo.test", inst)).toBeNull();
    expect(refusedHost("acme.com", inst)).toBeNull();
    expect(refusedHost("notvardo.test", inst)).toBeNull();
  });
});

describe("needsChallenge", () => {
  it("asks untrusted orgs for proof outside the instance base", () => {
    expect(needsChallenge("acme.com", inst, untrusted)).toBe(true);
    expect(needsChallenge("blog.vardo.test", inst, untrusted)).toBe(false);
    expect(needsChallenge("evilvardo.test", inst, untrusted)).toBe(true);
  });

  it("skips trusted orgs", () => {
    expect(needsChallenge("acme.com", inst, trusted)).toBe(false);
  });
});

describe("isRoutable", () => {
  const unverified = { domain: "acme.com", verifiedAt: null };

  it("keeps an untrusted org's unverified domain off the routes", () => {
    expect(isRoutable(unverified, inst, untrusted, [])).toBe(false);
  });

  it("routes it once verified, or inside a zone the org verified", () => {
    expect(isRoutable({ ...unverified, verifiedAt: new Date() }, inst, untrusted, [])).toBe(true);
    expect(isRoutable({ domain: "app.acme.com", verifiedAt: null }, inst, untrusted, ["acme.com"])).toBe(true);
    expect(isRoutable({ domain: "app.other.com", verifiedAt: null }, inst, untrusted, ["acme.com"])).toBe(false);
  });

  it("routes trusted orgs and instance subdomains without proof", () => {
    expect(isRoutable(unverified, inst, trusted, [])).toBe(true);
    expect(isRoutable({ domain: "blog.vardo.test", verifiedAt: null }, inst, untrusted, [])).toBe(true);
  });

  it("never routes the console host or the base domain, even verified or trusted", () => {
    for (const domain of ["console.vardo.test", "vardo.test"]) {
      expect(isRoutable({ domain, verifiedAt: new Date() }, inst, trusted, ["vardo.test"])).toBe(false);
    }
  });
});

describe("checkChallenge", () => {
  const token = "vardo-abc";

  it("asks for the TXT record at _vardo-challenge.<host>", async () => {
    const resolve = vi.fn().mockResolvedValue([[token]]);
    expect(await checkChallenge("acme.com", token, resolve)).toEqual({ status: "verified" });
    expect(resolve).toHaveBeenCalledWith("_vardo-challenge.acme.com");
    expect(challengeName("Acme.com")).toBe("_vardo-challenge.acme.com");
  });

  it("joins records split into chunks", async () => {
    expect(await checkChallenge("acme.com", token, async () => [["vardo-", "abc"]])).toEqual({ status: "verified" });
  });

  it("rejects another token", async () => {
    expect(await checkChallenge("acme.com", token, async () => [["vardo-other"], ["v=spf1"]]))
      .toEqual({ status: "missing", found: ["vardo-other", "v=spf1"] });
  });

  it("treats NXDOMAIN and no data as missing, other failures as errors", async () => {
    const fail = (code: string) => async () => { throw Object.assign(new Error(code), { code }); };
    expect(await checkChallenge("acme.com", token, fail("ENOTFOUND"))).toEqual({ status: "missing", found: [] });
    expect(await checkChallenge("acme.com", token, fail("ENODATA"))).toEqual({ status: "missing", found: [] });
    expect(await checkChallenge("acme.com", token, fail("ETIMEOUT"))).toEqual({ status: "error" });
    expect(await checkChallenge("acme.com", token, fail("ESERVFAIL"))).toEqual({ status: "error" });
  });
});

describe("verificationView", () => {
  const row = { domain: "acme.com", verifiedAt: null, verificationToken: "vardo-abc" };

  it("reports pending, verified and not-required", () => {
    expect(verificationView(row, inst, untrusted, []).state).toBe("pending");
    expect(verificationView({ ...row, verifiedAt: new Date() }, inst, untrusted, []).state).toBe("verified");
    expect(verificationView(row, inst, trusted, []).state).toBe("not-required");
    expect(verificationView({ ...row, domain: "x.vardo.test" }, inst, untrusted, []).state).toBe("not-required");
  });

  it("names the record to add", () => {
    expect(verificationView(row, inst, untrusted, [])).toMatchObject({
      recordName: "_vardo-challenge.acme.com",
      recordValue: "vardo-abc",
    });
  });
});

describe("consoleHostsFrom", () => {
  it("collects the instance domain, VARDO_DOMAIN and the auth URLs", () => {
    vi.stubEnv("VARDO_DOMAIN", "Vardo.Example.com");
    vi.stubEnv("NEXT_PUBLIC_BETTER_AUTH_URL", "https://auth.example.com/");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3008");
    try {
      expect(consoleHostsFrom("console.vardo.test").sort()).toEqual(
        ["auth.example.com", "console.vardo.test", "localhost", "vardo.example.com"],
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
