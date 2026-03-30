import { describe, it, expect } from "vitest";
import { parseContainerEnvVars, getPgErrorCode, isSensitiveEnvKey } from "@/lib/docker/import";

// ---------------------------------------------------------------------------
// parseContainerEnvVars
// ---------------------------------------------------------------------------

describe("parseContainerEnvVars", () => {
  it("parses simple KEY=VALUE entries", () => {
    const { vars, skippedKeys } = parseContainerEnvVars(["FOO=bar", "BAZ=qux"]);
    expect(vars).toEqual({ FOO: "bar", BAZ: "qux" });
    expect(skippedKeys).toHaveLength(0);
  });

  it("splits on the first = only — values may contain =", () => {
    const { vars } = parseContainerEnvVars(["URL=http://host?a=1&b=2"]);
    expect(vars).toEqual({ URL: "http://host?a=1&b=2" });
  });

  it("skips entries with no = separator", () => {
    const { vars, skippedKeys } = parseContainerEnvVars(["NOEQUAL", "GOOD=value"]);
    expect(vars).toEqual({ GOOD: "value" });
    expect(skippedKeys).toHaveLength(0);
  });

  it("skips values containing ${...} and records the key", () => {
    const { vars, skippedKeys } = parseContainerEnvVars([
      "SAFE=literal",
      "UNSAFE=${SOME_VAR}",
    ]);
    expect(vars).toEqual({ SAFE: "literal" });
    expect(skippedKeys).toEqual(["UNSAFE"]);
  });

  it("skips inline interpolation in the middle of a value", () => {
    const { vars, skippedKeys } = parseContainerEnvVars(["PREFIX=foo${BAR}baz"]);
    expect(vars).toEqual({});
    expect(skippedKeys).toEqual(["PREFIX"]);
  });

  it("handles empty value (KEY=)", () => {
    const { vars, skippedKeys } = parseContainerEnvVars(["EMPTY="]);
    expect(vars).toEqual({ EMPTY: "" });
    expect(skippedKeys).toHaveLength(0);
  });

  it("returns empty results for an empty array", () => {
    const { vars, skippedKeys } = parseContainerEnvVars([]);
    expect(vars).toEqual({});
    expect(skippedKeys).toHaveLength(0);
  });

  it("collects multiple skipped keys", () => {
    const { skippedKeys } = parseContainerEnvVars([
      "A=${X}",
      "B=${Y}",
      "C=safe",
    ]);
    expect(skippedKeys).toEqual(["A", "B"]);
  });
});

// ---------------------------------------------------------------------------
// isSensitiveEnvKey
// ---------------------------------------------------------------------------

describe("isSensitiveEnvKey", () => {
  it("matches PASSWORD variants", () => {
    expect(isSensitiveEnvKey("DB_PASSWORD")).toBe(true);
    expect(isSensitiveEnvKey("POSTGRES_PASSWORD")).toBe(true);
    expect(isSensitiveEnvKey("VPN_PASSWORD")).toBe(true);
    expect(isSensitiveEnvKey("MYSQL_ROOT_PASSWORD")).toBe(true);
  });

  it("matches PASSWD", () => {
    expect(isSensitiveEnvKey("DB_PASSWD")).toBe(true);
  });

  it("matches SECRET variants", () => {
    expect(isSensitiveEnvKey("JWT_SECRET")).toBe(true);
    expect(isSensitiveEnvKey("OAUTH_SECRET")).toBe(true);
    expect(isSensitiveEnvKey("SECRET_KEY")).toBe(true);
    expect(isSensitiveEnvKey("APP_SECRET")).toBe(true);
  });

  it("matches TOKEN variants", () => {
    expect(isSensitiveEnvKey("AUTH_TOKEN")).toBe(true);
    expect(isSensitiveEnvKey("API_TOKEN")).toBe(true);
    expect(isSensitiveEnvKey("BEARER_TOKEN")).toBe(true);
    expect(isSensitiveEnvKey("WG_TOKEN")).toBe(true);
  });

  it("matches PRIVATE_KEY", () => {
    expect(isSensitiveEnvKey("WIREGUARD_PRIVATE_KEY")).toBe(true);
    expect(isSensitiveEnvKey("SSH_PRIVATE_KEY")).toBe(true);
  });

  it("matches API_KEY", () => {
    expect(isSensitiveEnvKey("API_KEY")).toBe(true);
    expect(isSensitiveEnvKey("STRIPE_API_KEY")).toBe(true);
    expect(isSensitiveEnvKey("SENDGRID_API_KEY")).toBe(true);
  });

  it("matches ACCESS_KEY", () => {
    expect(isSensitiveEnvKey("AWS_ACCESS_KEY_ID")).toBe(true);
    expect(isSensitiveEnvKey("ACCESS_KEY")).toBe(true);
  });

  it("matches CREDENTIAL variants", () => {
    expect(isSensitiveEnvKey("SERVICE_CREDENTIALS")).toBe(true);
    expect(isSensitiveEnvKey("GOOGLE_APPLICATION_CREDENTIALS")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isSensitiveEnvKey("db_password")).toBe(true);
    expect(isSensitiveEnvKey("Api_Token")).toBe(true);
  });

  it("does not match non-sensitive keys", () => {
    expect(isSensitiveEnvKey("DATABASE_URL")).toBe(false);
    expect(isSensitiveEnvKey("REDIS_HOST")).toBe(false);
    expect(isSensitiveEnvKey("PORT")).toBe(false);
    expect(isSensitiveEnvKey("NODE_ENV")).toBe(false);
    expect(isSensitiveEnvKey("APP_NAME")).toBe(false);
    expect(isSensitiveEnvKey("LOG_LEVEL")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getPgErrorCode
// ---------------------------------------------------------------------------

describe("getPgErrorCode", () => {
  it("returns null for non-Error values", () => {
    expect(getPgErrorCode("string")).toBeNull();
    expect(getPgErrorCode(42)).toBeNull();
    expect(getPgErrorCode(null)).toBeNull();
  });

  it("returns the direct code property when present", () => {
    const err = Object.assign(new Error("test"), { code: "23505" });
    expect(getPgErrorCode(err)).toBe("23505");
  });

  it("returns the cause.code when direct code is absent", () => {
    const err = new Error("wrapper");
    err.cause = { code: "23503" };
    expect(getPgErrorCode(err)).toBe("23503");
  });

  it("returns null when neither code nor cause.code exists", () => {
    expect(getPgErrorCode(new Error("plain"))).toBeNull();
  });
});
