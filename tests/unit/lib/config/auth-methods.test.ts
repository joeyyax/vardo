import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ALL_AUTH_METHODS,
  assertMethodsRemain,
  authMethodEnvVar,
  authMethodFromEnv,
  getAllAuthMethods,
  resolveAuthMethod,
  type AuthMethod,
  type AuthMethodLayers,
} from "@/lib/config/auth-methods";

const layers = {
  config: {} as Record<string, boolean>,
  database: {} as Record<string, boolean>,
  featureConfig: {} as Record<string, boolean>,
  featureDatabase: {} as Record<string, boolean>,
};
let github: { clientId?: string; clientSecret?: string } | null = null;
let email: { provider?: string } | null = null;

vi.mock("@/lib/system-settings", () => ({
  getAuthMethodConfigLayers: async () => ({ config: layers.config, database: layers.database }),
  getFeatureFlagLayers: async () => ({
    config: layers.featureConfig,
    database: layers.featureDatabase,
  }),
  getGitHubAppConfig: async () => github,
  getEmailProviderConfig: async () => email,
}));

beforeEach(() => {
  layers.config = {};
  layers.database = {};
  layers.featureConfig = {};
  layers.featureDatabase = {};
  github = { clientId: "id", clientSecret: "secret" };
  email = { provider: "smtp" };
});

const empty: AuthMethodLayers = {
  config: {},
  database: {},
  legacyConfig: {},
  legacyDatabase: {},
};

// ---------------------------------------------------------------------------
// Enforcement — a method nothing reads is an inert toggle
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "../../../..");
const SCAN_DIRS = ["app", "lib", "components"];
const DECLARATION = join(ROOT, "lib/config/auth-methods.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && full !== DECLARATION) {
      out.push(full);
    }
  }
  return out;
}

const CORPUS = SCAN_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

describe("auth method enforcement", () => {
  it.each(ALL_AUTH_METHODS)("%s is enforced somewhere outside its declaration", (method) => {
    const quoted = `["']${method.replace(/-/g, "\\-")}["']`;
    const key = method.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
    const patterns = [
      new RegExp(`isAuthMethodEnabled(?:Async)?\\(\\s*${quoted}`),
      new RegExp(`METHOD_PATHS[\\s\\S]*${quoted}`),
      new RegExp(`methods\\.${key}\\b`),
      new RegExp(`methods\\[${quoted}\\]`),
    ];
    expect(patterns.some((p) => p.test(CORPUS))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Env var scheme
// ---------------------------------------------------------------------------

describe("authMethodEnvVar", () => {
  it("upper-snake-cases the method name", () => {
    expect(authMethodEnvVar("password")).toBe("VARDO_AUTH_PASSWORD");
    expect(authMethodEnvVar("magic-link")).toBe("VARDO_AUTH_MAGIC_LINK");
    expect(authMethodEnvVar("github")).toBe("VARDO_AUTH_GITHUB");
  });

  it("maps every method to a distinct env var", () => {
    const names = ALL_AUTH_METHODS.map(authMethodEnvVar);
    expect(new Set(names).size).toBe(ALL_AUTH_METHODS.length);
  });
});

describe("authMethodFromEnv", () => {
  afterEach(() => {
    delete process.env.VARDO_AUTH_PASSKEY;
    delete process.env.VARDO_AUTH_PASSWORD;
    delete process.env.VARDO_FEATURE_PASSWORD_AUTH;
  });

  it("returns undefined when unset", () => {
    expect(authMethodFromEnv("passkey")).toBeUndefined();
  });

  it.each(["1", "true", "TRUE", " yes ", "on", "enabled"])("reads %s as true", (raw) => {
    process.env.VARDO_AUTH_PASSKEY = raw;
    expect(authMethodFromEnv("passkey")).toBe(true);
  });

  it.each(["0", "false", "FALSE", " no ", "off", "disabled"])("reads %s as false", (raw) => {
    process.env.VARDO_AUTH_PASSKEY = raw;
    expect(authMethodFromEnv("passkey")).toBe(false);
  });

  it("ignores values it can't parse", () => {
    process.env.VARDO_AUTH_PASSKEY = "maybe";
    expect(authMethodFromEnv("passkey")).toBeUndefined();
  });

  it("still honors the retired passwordAuth env pin", () => {
    process.env.VARDO_FEATURE_PASSWORD_AUTH = "false";
    expect(authMethodFromEnv("password")).toBe(false);
  });

  it("prefers the new env var over the retired one", () => {
    process.env.VARDO_FEATURE_PASSWORD_AUTH = "false";
    process.env.VARDO_AUTH_PASSWORD = "true";
    expect(authMethodFromEnv("password")).toBe(true);
  });

  it("does not apply the password alias to other methods", () => {
    process.env.VARDO_FEATURE_PASSWORD_AUTH = "false";
    expect(authMethodFromEnv("passkey")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Precedence — env > vardo.yml > DB > default, aliases one rung below their own layer
// ---------------------------------------------------------------------------

describe("resolveAuthMethod", () => {
  afterEach(() => {
    delete process.env.VARDO_AUTH_PASSKEY;
    delete process.env.VARDO_FEATURE_PASSWORD_AUTH;
  });

  it("defaults every method to on", () => {
    for (const method of ALL_AUTH_METHODS) {
      expect(resolveAuthMethod(method, empty).enabled).toBe(true);
      expect(resolveAuthMethod(method, empty).source).toBe("default");
    }
  });

  it("prefers the DB over the default", () => {
    const result = resolveAuthMethod("passkey", { ...empty, database: { passkey: false } });
    expect(result).toMatchObject({ enabled: false, source: "database" });
  });

  it("prefers vardo.yml over the DB", () => {
    const result = resolveAuthMethod("passkey", {
      ...empty,
      config: { passkey: true },
      database: { passkey: false },
    });
    expect(result).toMatchObject({ enabled: true, source: "config" });
  });

  it("prefers the env var over everything", () => {
    process.env.VARDO_AUTH_PASSKEY = "false";
    const result = resolveAuthMethod("passkey", {
      ...empty,
      config: { passkey: true },
      database: { passkey: true },
    });
    expect(result).toMatchObject({ enabled: false, source: "env" });
  });

  it("reads the retired passwordAuth flag from vardo.yml", () => {
    const result = resolveAuthMethod("password", {
      ...empty,
      legacyConfig: { passwordAuth: false },
    });
    expect(result).toMatchObject({ enabled: false, source: "config" });
  });

  it("reads the retired passwordAuth flag from the DB", () => {
    const result = resolveAuthMethod("password", {
      ...empty,
      legacyDatabase: { passwordAuth: false },
    });
    expect(result).toMatchObject({ enabled: false, source: "database" });
  });

  it("prefers an explicit method key over the retired flag in the same layer", () => {
    const result = resolveAuthMethod("password", {
      ...empty,
      database: { password: true },
      legacyDatabase: { passwordAuth: false },
    });
    expect(result).toMatchObject({ enabled: true, source: "database" });
  });

  it("names the retired env var when that is what pinned it", () => {
    process.env.VARDO_FEATURE_PASSWORD_AUTH = "false";
    expect(resolveAuthMethod("password", empty).envVar).toBe("VARDO_FEATURE_PASSWORD_AUTH");
  });
});

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

describe("getAllAuthMethods", () => {
  it("marks GitHub unavailable when no app is configured", async () => {
    github = null;
    const methods = await getAllAuthMethods();
    const entry = methods.find((m) => m.method === "github")!;
    expect(entry.unavailable).toBe(true);
    expect(entry.unavailableReason).toMatch(/GitHub app/);
  });

  it("marks magic link unavailable when no email provider is set", async () => {
    email = null;
    const methods = await getAllAuthMethods();
    const entry = methods.find((m) => m.method === "magic-link")!;
    expect(entry.unavailable).toBe(true);
    expect(entry.unavailableReason).toMatch(/email/);
  });

  it("leaves methods without prerequisites available", async () => {
    github = null;
    email = null;
    const methods = await getAllAuthMethods();
    for (const method of ["password", "passkey", "totp"] as AuthMethod[]) {
      expect(methods.find((m) => m.method === method)!.unavailable).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Lockout guard
// ---------------------------------------------------------------------------

describe("assertMethodsRemain", () => {
  it("allows a write while another method stays usable", async () => {
    expect(await assertMethodsRemain({ password: false })).toBeNull();
  });

  it("refuses the write that would disable the last method", async () => {
    layers.database = { passkey: false, "magic-link": false, totp: false, github: false };
    expect(await assertMethodsRemain({ password: false })).toMatch(/lock everyone out/);
  });

  it("does not count a method whose prerequisite is missing", async () => {
    github = null;
    layers.database = { passkey: false, "magic-link": false, totp: false, github: true };
    expect(await assertMethodsRemain({ password: false })).toMatch(/lock everyone out/);
  });

  it("counts a method the same write is turning on", async () => {
    layers.database = { passkey: false, "magic-link": false, totp: false, github: false };
    expect(await assertMethodsRemain({ password: false, passkey: true })).toBeNull();
  });

  it("reads the retired flag when deciding what is left", async () => {
    layers.featureDatabase = { passwordAuth: false };
    layers.database = { "magic-link": false, totp: false, github: false };
    expect(await assertMethodsRemain({ passkey: false })).toMatch(/lock everyone out/);
  });
});
