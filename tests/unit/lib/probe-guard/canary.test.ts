import { describe, expect, it } from "vitest";
import {
  MARKER_RE,
  basicAuthPrefix,
  canaryRegexp,
  canaryValues,
  findMarker,
  generateMarker,
  renderDecoyEnv,
} from "@/lib/probe-guard/canary";

describe("generateMarker", () => {
  it("makes unique twelve-character markers", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generateMarker()));
    expect(seen.size).toBe(2000);
    for (const m of seen) expect(m).toMatch(MARKER_RE);
  });
});

describe("canaryValues", () => {
  const marker = "abcdefghjk23";
  const values = canaryValues(marker);

  it("carries the marker in every credential", () => {
    for (const key of ["DATABASE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "ADMIN_USER", "ADMIN_PASSWORD", "SECRET_KEY"]) {
      expect(values[key].toLowerCase(), key).toContain(marker);
    }
  });

  it("can't be a real credential anywhere", () => {
    // Real access key ids are AKIA plus 16 of [A-Z2-7]; an underscore can't appear.
    expect(values.AWS_ACCESS_KEY_ID).not.toMatch(/^AKIA[A-Z2-7]{16}$/);
    expect(values.AWS_ACCESS_KEY_ID).toContain("_EXAMPLE");
    // Real secret keys are exactly 40 base64 characters.
    expect(values.AWS_SECRET_ACCESS_KEY).not.toMatch(/^[A-Za-z0-9/+]{40}$/);
    // .invalid never resolves.
    expect(new URL(values.DATABASE_URL).hostname).toMatch(/\.invalid$/);
    for (const v of Object.values(values)) expect(v).not.toMatch(/sk_live_|ghp_|xox[bp]-|AIza/);
  });

  it("renders a plain .env", () => {
    expect(renderDecoyEnv(marker)).toMatch(/^APP_ENV=production\n[\s\S]*SECRET_KEY=.*\n$/);
  });

  it("refuses a malformed marker", () => {
    expect(() => canaryValues("x`) || Host(`y")).toThrow();
  });
});

describe("findMarker", () => {
  const markers = ["abcdefghjk23", "zzzzzzzzzzzz"];
  const values = canaryValues(markers[0]);

  it("finds a marker in a bearer token, query value or cookie", () => {
    expect(findMarker(`Bearer ${values.SECRET_KEY}`, markers)).toBe(markers[0]);
    expect(findMarker(values.AWS_ACCESS_KEY_ID, markers)).toBe(markers[0]);
    expect(findMarker(`AWS4-HMAC-SHA256 Credential=${values.AWS_ACCESS_KEY_ID}/20260101/us-east-1/s3/aws4_request`, markers)).toBe(markers[0]);
  });

  it("finds a basic-auth username whatever the password", () => {
    for (const user of [values.ADMIN_USER, values.AWS_ACCESS_KEY_ID]) {
      for (const pw of ["", "x", "xy", "longer-password"]) {
        const header = `Basic ${Buffer.from(`${user}:${pw}`).toString("base64")}`;
        expect(findMarker(header, markers), `${user}:${pw}`).toBe(markers[0]);
      }
    }
  });

  it("ignores ordinary credentials", () => {
    expect(findMarker("Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc", markers)).toBeNull();
    expect(findMarker(`Basic ${Buffer.from("admin:hunter2").toString("base64")}`, markers)).toBeNull();
    expect(findMarker("", markers)).toBeNull();
  });
});

describe("canaryRegexp", () => {
  it("matches what findMarker matches", () => {
    const marker = "abcdefghjk23";
    const values = canaryValues(marker);
    const re = new RegExp(canaryRegexp([marker]), "i");
    expect(re.test(`Bearer ${values.SECRET_KEY}`)).toBe(true);
    expect(re.test(`Basic ${Buffer.from(`${values.ADMIN_USER}:pw`).toString("base64")}`)).toBe(true);
    expect(re.test("Basic YWRtaW46aHVudGVyMg==")).toBe(false);
  });

  it("skips malformed markers", () => {
    expect(canaryRegexp(["bad`marker"])).toBe("");
  });

  it("keeps the base64 prefix fixed", () => {
    expect(basicAuthPrefix("ab")).toBe(Buffer.from("ab:").toString("base64"));
    expect(basicAuthPrefix("abc")).toBe(Buffer.from("abc").toString("base64"));
  });
});
