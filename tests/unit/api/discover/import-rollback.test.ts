import { describe, it, expect } from "vitest";
import {
  parseContainerEnvVars,
  getPgErrorCode,
  isSensitiveEnvKey,
  parseComposeDependsOn,
  isComposeProjectNetwork,
} from "@/lib/docker/import";

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
// isComposeProjectNetwork
// ---------------------------------------------------------------------------

describe("isComposeProjectNetwork", () => {
  it("matches {project}_default pattern", () => {
    expect(isComposeProjectNetwork("paperless_default", "paperless")).toBe(true);
    expect(isComposeProjectNetwork("mystack_default", "mystack")).toBe(true);
  });

  it("matches the project name itself", () => {
    expect(isComposeProjectNetwork("paperless", "paperless")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isComposeProjectNetwork("Paperless_Default", "paperless")).toBe(true);
    expect(isComposeProjectNetwork("paperless_default", "Paperless")).toBe(true);
  });

  it("does not match unrelated networks", () => {
    expect(isComposeProjectNetwork("bridge", "paperless")).toBe(false);
    expect(isComposeProjectNetwork("host", "paperless")).toBe(false);
    expect(isComposeProjectNetwork("vardo-network", "paperless")).toBe(false);
    expect(isComposeProjectNetwork("other_default", "paperless")).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(isComposeProjectNetwork("", "paperless")).toBe(false);
    expect(isComposeProjectNetwork("paperless_default", "")).toBe(false);
    expect(isComposeProjectNetwork("", "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseComposeDependsOn
// ---------------------------------------------------------------------------

describe("parseComposeDependsOn", () => {
  it("parses standard depends_on label format", () => {
    const labels = {
      "com.docker.compose.depends_on": "redis:service_started:false,postgres:service_started:false",
    };
    expect(parseComposeDependsOn(labels)).toEqual(["redis", "postgres"]);
  });

  it("handles a single dependency", () => {
    const labels = {
      "com.docker.compose.depends_on": "db:service_started:false",
    };
    expect(parseComposeDependsOn(labels)).toEqual(["db"]);
  });

  it("returns empty array when label is absent", () => {
    expect(parseComposeDependsOn({})).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseComposeDependsOn({ "com.docker.compose.depends_on": "" })).toEqual([]);
  });

  it("handles entries with varying condition formats", () => {
    const labels = {
      "com.docker.compose.depends_on": "redis:service_healthy:true,postgres:service_started:false",
    };
    expect(parseComposeDependsOn(labels)).toEqual(["redis", "postgres"]);
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
