import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ALL_FEATURE_FLAGS,
  FLAG_GROUPS,
  featureFlagEnvVar,
  featureFlagFromEnv,
  getFlagConfig,
  resolveFeatureFlag,
  type FeatureFlag,
} from "@/lib/config/features";

// ---------------------------------------------------------------------------
// Enforcement — a declared flag that no accessor reads is an inert toggle
// ---------------------------------------------------------------------------
// Flags are read three ways: isFeatureEnabled/isFeatureEnabledAsync, a
// `gate: "<flag>"` property on admin nav and tab entries, and
// requirePlugin("<flag>"). This scans source for those call sites rather than
// keeping a hand-written list, so a new inert flag fails here instead of
// shipping as a switch that does nothing.

const ROOT = resolve(__dirname, "../../../..");
const SCAN_DIRS = ["app", "lib", "components", "scripts"];
const SOURCE_EXT = [".ts", ".tsx"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build"]);

// The declaration site itself, so its own type union doesn't count as a read.
const DECLARATION = join(ROOT, "lib/config/features.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (SOURCE_EXT.some((ext) => entry.endsWith(ext)) && full !== DECLARATION) {
      out.push(full);
    }
  }
  return out;
}

const CORPUS = SCAN_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

/** Accessor call sites that read a given flag. */
function accessorPatterns(flag: FeatureFlag): RegExp[] {
  const quoted = `["']${flag.replace(/[-]/g, "\\-")}["']`;
  return [
    new RegExp(`isFeatureEnabled(?:Async)?\\(\\s*${quoted}`),
    new RegExp(`requirePlugin\\(\\s*${quoted}`),
    new RegExp(`gate:\\s*${quoted}`),
  ];
}

describe("feature flag enforcement", () => {
  it.each(ALL_FEATURE_FLAGS)("%s is read by at least one accessor", (flag) => {
    const hit = accessorPatterns(flag).some((re) => re.test(CORPUS));
    expect(
      hit,
      `Flag "${flag}" is declared but no accessor reads it. Wire it up with ` +
        `isFeatureEnabled/isFeatureEnabledAsync, requirePlugin("${flag}"), or a ` +
        `gate: "${flag}" nav entry — or remove the flag.`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Declaration hygiene
// ---------------------------------------------------------------------------

describe("feature flag declarations", () => {
  it("gives every flag a group that exists", () => {
    const known = new Set(FLAG_GROUPS.map((g) => g.id));
    for (const flag of ALL_FEATURE_FLAGS) {
      expect(known, `Flag "${flag}" has an unknown group`).toContain(getFlagConfig(flag).group);
    }
  });

  it("gives every group at least one flag", () => {
    for (const group of FLAG_GROUPS) {
      const members = ALL_FEATURE_FLAGS.filter((f) => getFlagConfig(f).group === group.id);
      expect(members.length, `Group "${group.id}" has no flags`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// teams — hides management, never revokes access
// ---------------------------------------------------------------------------
// Turning teams off must not lock an existing member out. Sign-in, session and
// membership resolution stay clear of the flag; only the management surfaces
// gate on it.

const ACCESS_PATHS = [
  "lib/auth/session.ts",
  "lib/auth/index.ts",
  "lib/auth/permissions.ts",
  "lib/api/verify-access.ts",
  "app/api/v1/organizations/switch/route.ts",
];

const TEAMS_MANAGEMENT_PATHS = [
  "app/api/v1/organizations/[orgId]/invitations/route.ts",
  "app/api/v1/organizations/[orgId]/invitations/[invitationId]/route.ts",
  "app/api/v1/organizations/[orgId]/members/route.ts",
  "app/api/v1/organizations/[orgId]/members/[userId]/route.ts",
  "app/api/v1/invitations/accept/route.ts",
];

describe("teams flag", () => {
  it("defaults to on", () => {
    expect(resolveFeatureFlag("teams", { config: {}, database: {} })).toEqual({
      enabled: true,
      source: "default",
    });
  });

  it.each(ACCESS_PATHS)("leaves %s ungated", (rel) => {
    const source = readFileSync(join(ROOT, rel), "utf8");
    expect(
      source,
      `${rel} reads the teams flag. Disabling teams must not affect sign-in or ` +
        `membership resolution for existing members.`,
    ).not.toMatch(/["']teams["']/);
  });

  it.each(TEAMS_MANAGEMENT_PATHS)("gates %s", (rel) => {
    const source = readFileSync(join(ROOT, rel), "utf8");
    expect(source).toMatch(/requirePlugin\(\s*["']teams["']/);
  });
});

// ---------------------------------------------------------------------------
// Env var scheme
// ---------------------------------------------------------------------------

describe("featureFlagEnvVar", () => {
  it("upper-snake-cases kebab and camelCase names alike", () => {
    expect(featureFlagEnvVar("domain-monitoring")).toBe("VARDO_FEATURE_DOMAIN_MONITORING");
    expect(featureFlagEnvVar("bindMounts")).toBe("VARDO_FEATURE_BIND_MOUNTS");
    expect(featureFlagEnvVar("selfManagement")).toBe("VARDO_FEATURE_SELF_MANAGEMENT");
    expect(featureFlagEnvVar("ssl")).toBe("VARDO_FEATURE_SSL");
  });

  it("maps every flag to a distinct env var", () => {
    const names = ALL_FEATURE_FLAGS.map(featureFlagEnvVar);
    expect(new Set(names).size).toBe(ALL_FEATURE_FLAGS.length);
  });
});

describe("featureFlagFromEnv", () => {
  const VAR = featureFlagEnvVar("metrics");
  afterEach(() => {
    delete process.env[VAR];
  });

  it("returns undefined when unset", () => {
    expect(featureFlagFromEnv("metrics")).toBeUndefined();
  });

  it.each(["1", "true", "TRUE", " yes ", "on", "enabled"])("reads %s as true", (raw) => {
    process.env[VAR] = raw;
    expect(featureFlagFromEnv("metrics")).toBe(true);
  });

  it.each(["0", "false", "FALSE", " no ", "off", "disabled"])("reads %s as false", (raw) => {
    process.env[VAR] = raw;
    expect(featureFlagFromEnv("metrics")).toBe(false);
  });

  it("ignores values it can't parse", () => {
    process.env[VAR] = "maybe";
    expect(featureFlagFromEnv("metrics")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Precedence — env > vardo.yml > DB > default
// ---------------------------------------------------------------------------

describe("resolveFeatureFlag", () => {
  const VAR = featureFlagEnvVar("backups");
  afterEach(() => {
    delete process.env[VAR];
  });

  const empty = { config: {}, database: {} };

  it("falls back to the declared default", () => {
    expect(resolveFeatureFlag("backups", empty)).toEqual({ enabled: true, source: "default" });
    expect(resolveFeatureFlag("bindMounts", empty)).toEqual({ enabled: false, source: "default" });
  });

  it("prefers the DB over the default", () => {
    expect(resolveFeatureFlag("backups", { config: {}, database: { backups: false } })).toEqual({
      enabled: false,
      source: "database",
    });
  });

  it("prefers vardo.yml over the DB", () => {
    expect(
      resolveFeatureFlag("backups", { config: { backups: true }, database: { backups: false } }),
    ).toEqual({ enabled: true, source: "config" });
  });

  it("prefers the env var over everything", () => {
    process.env[VAR] = "false";
    expect(
      resolveFeatureFlag("backups", { config: { backups: true }, database: { backups: true } }),
    ).toEqual({ enabled: false, source: "env" });
  });
});
