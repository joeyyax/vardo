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
    l.addSecrets(["k9Zr2mQpLx7"]);
    const out = l.log("#7 RUN echo STRIPE_KEY=k9Zr2mQpLx7 && curl k9Zr2mQpLx7");
    expect(out).not.toContain("k9Zr2mQpLx7");
    expect(addMock.mock.calls[0][1].line).toBe(out);
  });

  it("applies to lines logged after the values are added only", () => {
    const l = createDeployLogger("d2");
    expect(l.log("value k9Zr2mQpLx7")).toContain("k9Zr2mQpLx7");
    l.addSecrets(["k9Zr2mQpLx7"]);
    expect(l.log("value k9Zr2mQpLx7")).not.toContain("k9Zr2mQpLx7");
  });

  it("skips short and common values", () => {
    const l = createDeployLogger("d3");
    l.addSecrets(["abc", "true", "production", "Production", "12345"]);
    const line = "NODE_ENV=production DEBUG=true abc 12345";
    expect(l.log(line)).toBe(line);
  });

  it("redacts error text through the same set", () => {
    const l = createDeployLogger("d4");
    l.addSecrets(["k9Zr2mQpLx7"]);
    expect(l.redact("failed: k9Zr2mQpLx7")).not.toContain("k9Zr2mQpLx7");
  });
});
