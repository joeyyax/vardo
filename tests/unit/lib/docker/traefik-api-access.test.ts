import { createHash } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

const { traefikApiConfig, traefikApiHeaders, traefikApiPassword } = await import("@/lib/docker/traefik-api-access");

const saved = { key: process.env.ENCRYPTION_MASTER_KEY, auth: process.env.BETTER_AUTH_SECRET };
afterEach(() => {
  for (const [name, value] of [["ENCRYPTION_MASTER_KEY", saved.key], ["BETTER_AUTH_SECRET", saved.auth]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Traefik API access (#889)", () => {
  it("derives a stable password from the master key, not the key itself", () => {
    process.env.ENCRYPTION_MASTER_KEY = "a".repeat(64);
    const first = traefikApiPassword();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain("a".repeat(64));
    expect(traefikApiPassword()).toBe(first);
    process.env.ENCRYPTION_MASTER_KEY = "b".repeat(64);
    expect(traefikApiPassword()).not.toBe(first);
  });

  it("sends no credentials without a secret", () => {
    delete process.env.ENCRYPTION_MASTER_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    expect(traefikApiPassword()).toBeNull();
    expect(traefikApiHeaders()).toEqual({});
  });

  it("routes /api on the internal entrypoint behind the matching hash", () => {
    const config = traefikApiConfig("pw") as {
      http: { routers: Record<string, { entryPoints: string[]; service: string; middlewares: string[] }>; middlewares: Record<string, { basicAuth: { users: string[] } }> };
    };
    const router = config.http.routers["vardo-api"];
    expect(router.entryPoints).toEqual(["traefik"]);
    expect(router.service).toBe("api@internal");
    const users = config.http.middlewares[router.middlewares[0]].basicAuth.users;
    expect(users).toEqual([`vardo:{SHA}${createHash("sha1").update("pw").digest("base64")}`]);
  });
});
