// Per-app security response headers: settings, presets, validation and the Traefik headers middleware they render to.

import { z } from "zod";

export const HSTS_MAX_AGES = [
  { seconds: 86_400, label: "1 day" },
  { seconds: 604_800, label: "1 week" },
  { seconds: 15_768_000, label: "6 months" },
  { seconds: 31_536_000, label: "1 year" },
  { seconds: 63_072_000, label: "2 years" },
] as const;

export const FRAMING_OPTIONS = ["sameorigin", "deny", "off"] as const;
export type Framing = (typeof FRAMING_OPTIONS)[number];

export const REFERRER_POLICIES = [
  "strict-origin-when-cross-origin",
  "no-referrer",
  "same-origin",
  "origin",
  "off",
] as const;
export type ReferrerPolicy = (typeof REFERRER_POLICIES)[number];

export const PERMISSIONS_MODES = ["off", "preset", "custom"] as const;
export type PermissionsMode = (typeof PERMISSIONS_MODES)[number];

export const PERMISSIONS_PRESET = "camera=(), microphone=(), geolocation=()";

export type SecurityHeaderConfig = {
  hsts: { enabled: boolean; maxAge: number; includeSubDomains: boolean; preload: boolean };
  nosniff: boolean;
  framing: Framing;
  referrerPolicy: ReferrerPolicy;
  permissionsPolicy: { mode: PermissionsMode; custom: string };
  cspReportOnly: { enabled: boolean; policy: string };
};

export const RECOMMENDED_HEADERS: SecurityHeaderConfig = {
  hsts: { enabled: true, maxAge: 31_536_000, includeSubDomains: false, preload: false },
  nosniff: true,
  framing: "sameorigin",
  referrerPolicy: "strict-origin-when-cross-origin",
  permissionsPolicy: { mode: "off", custom: "" },
  cspReportOnly: { enabled: false, policy: "" },
};

export const OFF_HEADERS: SecurityHeaderConfig = {
  hsts: { enabled: false, maxAge: 31_536_000, includeSubDomains: false, preload: false },
  nosniff: false,
  framing: "off",
  referrerPolicy: "off",
  permissionsPolicy: { mode: "off", custom: "" },
  cspReportOnly: { enabled: false, policy: "" },
};

/** A preset applied over the current settings; custom strings are kept for when they're turned back on. */
export function applyHeaderPreset(current: SecurityHeaderConfig, preset: "recommended" | "off"): SecurityHeaderConfig {
  const base = preset === "recommended" ? RECOMMENDED_HEADERS : OFF_HEADERS;
  return {
    ...base,
    hsts: { ...base.hsts },
    permissionsPolicy: { mode: base.permissionsPolicy.mode, custom: current.permissionsPolicy.custom },
    cspReportOnly: { enabled: base.cspReportOnly.enabled, policy: current.cspReportOnly.policy },
  };
}

/** Which preset the settings match, or null for a custom mix. */
export function matchingPreset(config: SecurityHeaderConfig): "recommended" | "off" | null {
  const strip = (c: SecurityHeaderConfig) =>
    JSON.stringify({ ...c, permissionsPolicy: c.permissionsPolicy.mode, cspReportOnly: c.cspReportOnly.enabled });
  if (strip(config) === strip(RECOMMENDED_HEADERS)) return "recommended";
  if (strip(config) === strip(OFF_HEADERS)) return "off";
  return null;
}

const MAX_POLICY_LENGTH = 4096;
const UNSAFE_CHARS = /[\u0000-\u001f\u007f]/;

// feature=() / feature=* / feature=(self "https://a.example")
const PERMISSIONS_ITEM = /^[a-z][a-z0-9-]*=(\*|\((\s*(self|\*|src|"https?:\/\/[^"\s]+")\s*)*\))$/;

/** Why a Permissions-Policy value is refused, or null. */
export function permissionsPolicyProblem(value: string): string | null {
  const v = value.trim();
  if (!v) return "Enter a policy, e.g. camera=(), microphone=()";
  if (v.length > MAX_POLICY_LENGTH || UNSAFE_CHARS.test(v)) return "Keep the policy to one line under 4096 characters";
  const bad = v.split(",").map((s) => s.trim()).find((item) => !PERMISSIONS_ITEM.test(item));
  if (bad !== undefined) return `"${bad.slice(0, 60)}" isn't a feature=(allowlist) entry`;
  return null;
}

const CSP_DIRECTIVES = new Set([
  "default-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr",
  "img-src", "font-src", "connect-src", "media-src", "object-src", "frame-src", "child-src", "worker-src",
  "manifest-src", "prefetch-src", "base-uri", "form-action", "frame-ancestors", "sandbox", "report-uri",
  "report-to", "upgrade-insecure-requests", "block-all-mixed-content", "require-trusted-types-for",
  "trusted-types", "fenced-frame-src",
]);

function cspDirectiveNames(value: string): string[] {
  return value.split(";").map((d) => d.trim()).filter(Boolean).map((d) => d.split(/\s+/)[0].toLowerCase());
}

/** Why a Content-Security-Policy value is refused, or null. */
export function cspProblem(value: string, framing: Framing): string | null {
  const v = value.trim();
  if (!v) return "Enter a policy, e.g. default-src 'self'";
  if (v.length > MAX_POLICY_LENGTH || UNSAFE_CHARS.test(v)) return "Keep the policy to one line under 4096 characters";
  // A comma starts a second policy in the header.
  if (v.includes(",")) return "Separate directives with semicolons, not commas";
  const names = cspDirectiveNames(v);
  const unknown = names.find((n) => !CSP_DIRECTIVES.has(n));
  if (unknown) return `"${unknown.slice(0, 40)}" isn't a CSP directive`;
  if (new Set(names).size !== names.length) return "Each directive can appear once";
  if (framing !== "off" && names.includes("frame-ancestors")) {
    return "Remove frame-ancestors; the framing setting adds it";
  }
  return null;
}

/** Why the settings can't be saved, keyed by field, or an empty object. */
export function headerConfigProblems(config: SecurityHeaderConfig): Partial<Record<"permissionsPolicy" | "cspReportOnly", string>> {
  const problems: Partial<Record<"permissionsPolicy" | "cspReportOnly", string>> = {};
  if (config.permissionsPolicy.mode === "custom") {
    const p = permissionsPolicyProblem(config.permissionsPolicy.custom);
    if (p) problems.permissionsPolicy = p;
  }
  if (config.cspReportOnly.enabled) {
    const p = cspProblem(config.cspReportOnly.policy, config.framing);
    if (p) problems.cspReportOnly = p;
  }
  return problems;
}

const HSTS_SECONDS = HSTS_MAX_AGES.map((a) => a.seconds) as number[];

export const securityHeaderConfigSchema = z
  .object({
    hsts: z.object({
      enabled: z.boolean(),
      maxAge: z.number().int().refine((s) => HSTS_SECONDS.includes(s), "Pick one of the listed max ages"),
      includeSubDomains: z.boolean(),
      preload: z.boolean(),
    }).strict(),
    nosniff: z.boolean(),
    framing: z.enum(FRAMING_OPTIONS),
    referrerPolicy: z.enum(REFERRER_POLICIES),
    permissionsPolicy: z.object({ mode: z.enum(PERMISSIONS_MODES), custom: z.string().max(MAX_POLICY_LENGTH) }).strict(),
    cspReportOnly: z.object({ enabled: z.boolean(), policy: z.string().max(MAX_POLICY_LENGTH) }).strict(),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const [field, message] of Object.entries(headerConfigProblems(config))) {
      ctx.addIssue({ code: "custom", path: [field], message });
    }
  });

/** API input: the full settings, or the old on/off toggle. */
export const securityHeadersInputSchema = z
  .union([z.boolean(), securityHeaderConfigSchema])
  .transform((v): SecurityHeaderConfig => (v === true ? RECOMMENDED_HEADERS : v === false ? OFF_HEADERS : v));

/** A stored value read defensively: anything missing or malformed falls back to Recommended. */
export function normalizeHeaderConfig(raw: unknown): SecurityHeaderConfig {
  if (raw === true || raw == null) return RECOMMENDED_HEADERS;
  if (raw === false) return OFF_HEADERS;
  const parsed = securityHeaderConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : RECOMMENDED_HEADERS;
}

export type HeadersMiddlewareOptions = {
  stsSeconds?: number;
  stsIncludeSubdomains?: boolean;
  stsPreload?: boolean;
  contentTypeNosniff?: boolean;
  customFrameOptionsValue?: string;
  referrerPolicy?: string;
  permissionsPolicy?: string;
  contentSecurityPolicyReportOnly?: string;
};

const FRAME_ANCESTORS: Record<Exclude<Framing, "off">, { xfo: string; csp: string }> = {
  sameorigin: { xfo: "SAMEORIGIN", csp: "frame-ancestors 'self'" },
  deny: { xfo: "DENY", csp: "frame-ancestors 'none'" },
};

/** Traefik headers middleware options for the settings. Empty when every header is off. */
export function headersMiddlewareOptions(input: SecurityHeaderConfig): HeadersMiddlewareOptions {
  const config = normalizeHeaderConfig(input);
  const opts: HeadersMiddlewareOptions = {};
  // Traefik sends HSTS on HTTPS requests only.
  if (config.hsts.enabled) {
    opts.stsSeconds = config.hsts.maxAge;
    if (config.hsts.includeSubDomains) opts.stsIncludeSubdomains = true;
    if (config.hsts.preload) opts.stsPreload = true;
  }
  if (config.nosniff) opts.contentTypeNosniff = true;
  if (config.framing !== "off") opts.customFrameOptionsValue = FRAME_ANCESTORS[config.framing].xfo;
  if (config.referrerPolicy !== "off") opts.referrerPolicy = config.referrerPolicy;
  const permissions =
    config.permissionsPolicy.mode === "preset" ? PERMISSIONS_PRESET
    : config.permissionsPolicy.mode === "custom" ? config.permissionsPolicy.custom.trim()
    : "";
  if (permissions) opts.permissionsPolicy = permissions;
  if (config.cspReportOnly.enabled) {
    const policy = config.cspReportOnly.policy.trim().replace(/;\s*$/, "");
    const framing = config.framing !== "off" ? FRAME_ANCESTORS[config.framing].csp : "";
    const value = [policy, framing].filter(Boolean).join("; ");
    if (value) opts.contentSecurityPolicyReportOnly = value;
  }
  return opts;
}

/** The headers as docker labels under `traefik.http.middlewares.<name>.headers.`. */
export function headersLabelOptions(config: SecurityHeaderConfig): Record<string, string> {
  return Object.fromEntries(Object.entries(headersMiddlewareOptions(config)).map(([k, v]) => [k, String(v)]));
}

/** The middleware's name in Traefik's file provider. Keyed by id so renames and slots keep it. */
export function headersMiddlewareName(appId: string): string {
  return `vardo-headers-${appId}`;
}

/** The file-provider reference a router lists. */
export function headersMiddlewareRef(appId: string): string {
  return `${headersMiddlewareName(appId)}@file`;
}
