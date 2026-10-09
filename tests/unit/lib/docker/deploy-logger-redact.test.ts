import { describe, it, expect, vi, beforeEach } from "vitest";

const { addMock } = vi.hoisted(() => ({ addMock: vi.fn().mockResolvedValue("1-0") }));

vi.mock("@/lib/stream/producer", () => ({ addDeployLog: addMock }));
vi.mock("@/lib/stream/deploy-expiry", () => ({ expireDeployStream: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { createDeployLogger } from "@/lib/docker/deploy-logger";

beforeEach(() => vi.clearAllMocks());

describe("deploy logger env value redaction", () => {
  it("redacts a bare env value in a build line", () => {
    const l = createDeployLogger("d1");
    l.addSecrets({ STRIPE_KEY: "k9Zr2mQpLx7" });
    const out = l.log("#7 RUN echo STRIPE_KEY=k9Zr2mQpLx7 && curl k9Zr2mQpLx7");
    expect(out).not.toContain("k9Zr2mQpLx7");
    expect(addMock.mock.calls[0][1].line).toBe(out);
  });

  it("applies to lines logged after the values are added only", () => {
    const l = createDeployLogger("d2");
    expect(l.log("value k9Zr2mQpLx7")).toContain("k9Zr2mQpLx7");
    l.addSecrets({ STRIPE_KEY: "k9Zr2mQpLx7" });
    expect(l.log("value k9Zr2mQpLx7")).not.toContain("k9Zr2mQpLx7");
  });

  it("skips short and common values", () => {
    const l = createDeployLogger("d3");
    l.addSecrets({ A: "abc", B: "true", NODE_ENV: "production", C: "Production", D: "12345" });
    const line = "NODE_ENV=production DEBUG=true abc 12345";
    expect(l.log(line)).toBe(line);
  });

  it("redacts error text through the same set", () => {
    const l = createDeployLogger("d4");
    l.addSecrets({ STRIPE_KEY: "k9Zr2mQpLx7" });
    expect(l.redact("failed: k9Zr2mQpLx7")).not.toContain("k9Zr2mQpLx7");
  });

  it("keeps the app name and package scope when an env value equals the app name", () => {
    const l = createDeployLogger("d5");
    l.addPublicNames(["site-audit"]);
    l.addSecrets({ SHOTS_R2_PREFIX: "site-audit", NEXT_PUBLIC_NAME: "site-audit-web1" });
    const line = "/opt/vardo/apps/site-audit/production/blue/docker-compose.yml --filter @site-audit/web...";
    expect(l.log(line)).toBe(line);
  });

  it("masks a short password under a PASSWORD key", () => {
    const l = createDeployLogger("d6");
    l.addSecrets({ POSTGRES_PASSWORD: "hunter2" });
    expect(l.log("psql -w hunter2")).toBe("psql -w [redacted]");
  });

  it("masks only the password of a credentialed URL", () => {
    const l = createDeployLogger("d7");
    l.addSecrets({ DATABASE_URL: "postgres://app:s3cretPw@db:5432/app" });
    expect(l.log("connect db:5432 pw s3cretPw")).toBe("connect db:5432 pw [redacted]");
  });

  it("masks long mixed values under any key but not paths, URLs or words", () => {
    const l = createDeployLogger("d8");
    l.addSecrets({
      WEBHOOK: "a1b2c3d4e5f6a7b8",
      DIR: "/var/lib/some/path1234",
      SITE: "https://example.com/app1",
      MODE: "long-plain-word-value",
    });
    const line = "a1b2c3d4e5f6a7b8 /var/lib/some/path1234 https://example.com/app1 long-plain-word-value";
    expect(l.log(line)).toBe("[redacted] /var/lib/some/path1234 https://example.com/app1 long-plain-word-value");
  });
});
