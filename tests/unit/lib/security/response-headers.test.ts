import { describe, it, expect } from "vitest";
import {
  HSTS_MAX_AGES,
  OFF_HEADERS,
  PERMISSIONS_PRESET,
  RECOMMENDED_HEADERS,
  applyHeaderPreset,
  cspProblem,
  headerConfigProblems,
  headersLabelOptions,
  headersMiddlewareOptions,
  matchingPreset,
  normalizeHeaderConfig,
  permissionsPolicyProblem,
  securityHeadersInputSchema,
  type SecurityHeaderConfig,
} from "@/lib/security/response-headers";

const config = (patch: Partial<SecurityHeaderConfig>): SecurityHeaderConfig => ({ ...RECOMMENDED_HEADERS, ...patch });

describe("headersMiddlewareOptions", () => {
  it("renders Recommended as the four headers Vardo always sent", () => {
    expect(headersMiddlewareOptions(RECOMMENDED_HEADERS)).toEqual({
      stsSeconds: 31_536_000,
      contentTypeNosniff: true,
      customFrameOptionsValue: "SAMEORIGIN",
      referrerPolicy: "strict-origin-when-cross-origin",
    });
  });

  it("renders Off as nothing", () => {
    expect(headersMiddlewareOptions(OFF_HEADERS)).toEqual({});
  });

  it.each(HSTS_MAX_AGES.map((a) => a.seconds))("sends a max age of %i", (maxAge) => {
    expect(headersMiddlewareOptions(config({ hsts: { ...RECOMMENDED_HEADERS.hsts, maxAge } })).stsSeconds).toBe(maxAge);
  });

  it("adds includeSubDomains and preload only when on", () => {
    const both = headersMiddlewareOptions(config({ hsts: { enabled: true, maxAge: 63_072_000, includeSubDomains: true, preload: true } }));
    expect(both).toMatchObject({ stsSeconds: 63_072_000, stsIncludeSubdomains: true, stsPreload: true });
    expect(headersMiddlewareOptions(RECOMMENDED_HEADERS)).not.toHaveProperty("stsIncludeSubdomains");
    expect(headersMiddlewareOptions(RECOMMENDED_HEADERS)).not.toHaveProperty("stsPreload");
  });

  it("drops every HSTS option when HSTS is off, even with subdomains and preload set", () => {
    const opts = headersMiddlewareOptions(config({ hsts: { enabled: false, maxAge: 31_536_000, includeSubDomains: true, preload: true } }));
    expect(Object.keys(opts).filter((k) => k.startsWith("sts"))).toEqual([]);
  });

  it("maps framing to X-Frame-Options", () => {
    expect(headersMiddlewareOptions(config({ framing: "sameorigin" })).customFrameOptionsValue).toBe("SAMEORIGIN");
    expect(headersMiddlewareOptions(config({ framing: "deny" })).customFrameOptionsValue).toBe("DENY");
    expect(headersMiddlewareOptions(config({ framing: "off" }))).not.toHaveProperty("customFrameOptionsValue");
  });

  it.each(["strict-origin-when-cross-origin", "no-referrer", "same-origin", "origin"] as const)("sends Referrer-Policy %s", (referrerPolicy) => {
    expect(headersMiddlewareOptions(config({ referrerPolicy })).referrerPolicy).toBe(referrerPolicy);
  });

  it("leaves Referrer-Policy out when off", () => {
    expect(headersMiddlewareOptions(config({ referrerPolicy: "off" }))).not.toHaveProperty("referrerPolicy");
  });

  it("sends the Permissions-Policy preset or the custom string", () => {
    expect(headersMiddlewareOptions(config({ permissionsPolicy: { mode: "preset", custom: "" } })).permissionsPolicy).toBe(PERMISSIONS_PRESET);
    expect(
      headersMiddlewareOptions(config({ permissionsPolicy: { mode: "custom", custom: " camera=(self) " } })).permissionsPolicy,
    ).toBe("camera=(self)");
    expect(headersMiddlewareOptions(config({ permissionsPolicy: { mode: "off", custom: "camera=()" } }))).not.toHaveProperty("permissionsPolicy");
  });

  it("adds frame-ancestors to the report-only CSP to match framing", () => {
    const csp = (framing: SecurityHeaderConfig["framing"]) =>
      headersMiddlewareOptions(config({ framing, cspReportOnly: { enabled: true, policy: "default-src 'self';" } }))
        .contentSecurityPolicyReportOnly;
    expect(csp("sameorigin")).toBe("default-src 'self'; frame-ancestors 'self'");
    expect(csp("deny")).toBe("default-src 'self'; frame-ancestors 'none'");
    expect(csp("off")).toBe("default-src 'self'");
  });

  it("never sends the enforcing CSP header", () => {
    const opts = headersMiddlewareOptions(config({ cspReportOnly: { enabled: true, policy: "default-src 'self'" } }));
    expect(opts).not.toHaveProperty("contentSecurityPolicy");
  });

  it("never emits an empty value, whatever the combination", () => {
    const framings = ["sameorigin", "deny", "off"] as const;
    const referrers = ["strict-origin-when-cross-origin", "off"] as const;
    for (const hsts of [true, false])
      for (const nosniff of [true, false])
        for (const framing of framings)
          for (const referrerPolicy of referrers)
            for (const mode of ["off", "preset", "custom"] as const)
              for (const csp of [true, false]) {
                const opts = headersMiddlewareOptions({
                  hsts: { ...RECOMMENDED_HEADERS.hsts, enabled: hsts },
                  nosniff,
                  framing,
                  referrerPolicy,
                  permissionsPolicy: { mode, custom: "geolocation=()" },
                  cspReportOnly: { enabled: csp, policy: "img-src 'self'" },
                });
                for (const v of Object.values(opts)) expect(v === "" || v === undefined || v === null).toBe(false);
              }
  });

  it("falls back to Recommended for a value that fails validation", () => {
    const bad = config({ cspReportOnly: { enabled: true, policy: "nonsense" } });
    expect(headersMiddlewareOptions(bad)).toEqual(headersMiddlewareOptions(RECOMMENDED_HEADERS));
  });
});

describe("headersLabelOptions", () => {
  it("stringifies values for docker labels", () => {
    expect(headersLabelOptions(RECOMMENDED_HEADERS)).toEqual({
      stsSeconds: "31536000",
      contentTypeNosniff: "true",
      customFrameOptionsValue: "SAMEORIGIN",
      referrerPolicy: "strict-origin-when-cross-origin",
    });
  });
});

describe("presets", () => {
  it("Recommended matches the old on toggle and Off turns everything off", () => {
    const custom = config({ framing: "deny", permissionsPolicy: { mode: "custom", custom: "camera=()" } });
    expect(applyHeaderPreset(custom, "recommended")).toEqual({ ...RECOMMENDED_HEADERS, permissionsPolicy: { mode: "off", custom: "camera=()" } });
    expect(headersMiddlewareOptions(applyHeaderPreset(custom, "off"))).toEqual({});
  });

  it("keeps custom strings for when they're turned back on", () => {
    const custom = config({ cspReportOnly: { enabled: true, policy: "default-src 'self'" } });
    expect(applyHeaderPreset(custom, "off").cspReportOnly).toEqual({ enabled: false, policy: "default-src 'self'" });
  });

  it("names the preset the settings match", () => {
    expect(matchingPreset(RECOMMENDED_HEADERS)).toBe("recommended");
    expect(matchingPreset(OFF_HEADERS)).toBe("off");
    expect(matchingPreset({ ...OFF_HEADERS, cspReportOnly: { enabled: false, policy: "img-src 'self'" } })).toBe("off");
    expect(matchingPreset(config({ framing: "deny" }))).toBeNull();
  });
});

describe("validation", () => {
  it("accepts plausible Permissions-Policy lists", () => {
    expect(permissionsPolicyProblem("camera=(), microphone=(self), geolocation=(self \"https://maps.example.com\")")).toBeNull();
    expect(permissionsPolicyProblem("fullscreen=*")).toBeNull();
  });

  it.each(["", "camera", "camera=()\nx-evil: 1", "camera=(); microphone=()", "Camera=()"])("refuses Permissions-Policy %j", (v) => {
    expect(permissionsPolicyProblem(v)).not.toBeNull();
  });

  it("accepts plausible CSP directive lists", () => {
    expect(cspProblem("default-src 'self'; img-src 'self' data:; report-uri /csp", "off")).toBeNull();
    expect(cspProblem("upgrade-insecure-requests", "sameorigin")).toBeNull();
  });

  it.each([
    ["", "off"],
    ["default-src 'self', img-src *", "off"],
    ["bogus-src 'self'", "off"],
    ["default-src 'self'; default-src *", "off"],
    ["default-src 'self'\r\nSet-Cookie: x", "off"],
    ["frame-ancestors 'self'", "sameorigin"],
  ] as const)("refuses CSP %j with framing %s", (v, framing) => {
    expect(cspProblem(v, framing)).not.toBeNull();
  });

  it("lets the CSP set frame-ancestors when framing is off", () => {
    expect(cspProblem("frame-ancestors https://partner.example", "off")).toBeNull();
  });

  it("only checks strings that are switched on", () => {
    expect(headerConfigProblems(config({ permissionsPolicy: { mode: "off", custom: "junk" }, cspReportOnly: { enabled: false, policy: "junk" } }))).toEqual({});
  });
});

describe("API input", () => {
  it("maps the old toggle to the presets", () => {
    expect(securityHeadersInputSchema.parse(true)).toEqual(RECOMMENDED_HEADERS);
    expect(securityHeadersInputSchema.parse(false)).toEqual(OFF_HEADERS);
  });

  it("refuses unknown keys, unlisted max ages and bad policies", () => {
    expect(securityHeadersInputSchema.safeParse({ ...RECOMMENDED_HEADERS, extra: 1 }).success).toBe(false);
    expect(securityHeadersInputSchema.safeParse(config({ hsts: { ...RECOMMENDED_HEADERS.hsts, maxAge: 5 } })).success).toBe(false);
    const bad = securityHeadersInputSchema.safeParse(config({ cspReportOnly: { enabled: true, policy: "nope" } }));
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].path).toEqual(["cspReportOnly"]);
  });

  it("reads stored values defensively", () => {
    expect(normalizeHeaderConfig(undefined)).toEqual(RECOMMENDED_HEADERS);
    expect(normalizeHeaderConfig(false)).toEqual(OFF_HEADERS);
    expect(normalizeHeaderConfig({ nonsense: true })).toEqual(RECOMMENDED_HEADERS);
    const deny = config({ framing: "deny" });
    expect(normalizeHeaderConfig(deny)).toEqual(deny);
  });
});
