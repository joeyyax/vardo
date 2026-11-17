// A deploy's build secrets: an org secret beats the GitHub App token, and removing it falls back.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";

process.env.ENCRYPTION_MASTER_KEY = "1".repeat(64);

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn(async () => {}) }));

const { loadBuildSecrets } = await import("@/lib/build-secrets/deploy");
const { encrypt } = await import("@/lib/crypto/encrypt");
const { dockerfileBuildArgs } = await import("@/lib/docker/buildpack-args");
const { buildKey } = await import("@/lib/docker/build-key");
const { buildSecretEnv } = await import("@/lib/docker/build-secrets");

const APP_TOKEN = "ghs_installationToken0123456789abcdef";
const PAT = "ghp_classicPatWithReadPackages0123456789";

function context() {
  const lines: string[] = [];
  const masked: Record<string, string>[] = [];
  const ctx = {
    organizationId: "org-1",
    log: (line: string) => (lines.push(line), line),
    addSecrets: (env: Record<string, string>) => void masked.push(env),
    buildSecrets: undefined as Record<string, string> | undefined,
  };
  return { ctx, lines, masked };
}

const orgRows = (rows: { name: string; value: string }[]) =>
  dbMock.query.orgBuildSecrets.findMany.mockResolvedValue(rows.map((r) => ({ name: r.name, value: encrypt(r.value, "org-1") })));

beforeEach(() => dbMock.reset());

describe("loadBuildSecrets", () => {
  it("uses the GitHub App token when the org sets no npm_token", async () => {
    const { ctx, lines } = context();
    await loadBuildSecrets(ctx, APP_TOKEN);
    expect(ctx.buildSecrets).toEqual({ npm_token: APP_TOKEN });
    expect(lines).toEqual(["[deploy] Build secrets: npm_token (GitHub App token)"]);
  });

  it("lets the org's npm_token beat the GitHub App token", async () => {
    orgRows([{ name: "npm_token", value: PAT }, { name: "sentry_auth", value: "sntrys_x0123456789abcdef" }]);
    const { ctx, lines, masked } = context();
    await loadBuildSecrets(ctx, APP_TOKEN);
    expect(ctx.buildSecrets).toEqual({ npm_token: PAT, sentry_auth: "sntrys_x0123456789abcdef" });
    expect(lines).toEqual(["[deploy] Build secrets: npm_token (org secret), sentry_auth (org secret)"]);
    expect(Object.values(masked[0])).toContain(PAT);
    expect(lines.join("\n")).not.toContain(PAT);
  });

  it("falls back to the GitHub App token once the org secret is deleted", async () => {
    orgRows([{ name: "npm_token", value: PAT }]);
    const before = context();
    await loadBuildSecrets(before.ctx, APP_TOKEN);
    expect(before.ctx.buildSecrets?.npm_token).toBe(PAT);

    orgRows([]);
    const after = context();
    await loadBuildSecrets(after.ctx, APP_TOKEN);
    expect(after.ctx.buildSecrets).toEqual({ npm_token: APP_TOKEN });
  });

  it("gives an org secret without a GitHub token, and nothing without either", async () => {
    orgRows([{ name: "npm_token", value: PAT }]);
    const some = context();
    await loadBuildSecrets(some.ctx, null);
    expect(some.ctx.buildSecrets).toEqual({ npm_token: PAT });

    orgRows([]);
    const none = context();
    await loadBuildSecrets(none.ctx, null);
    expect(none.ctx.buildSecrets).toEqual({});
    expect(none.lines).toEqual([]);
  });

  it("skips a row that won't decrypt and builds on with the rest", async () => {
    dbMock.query.orgBuildSecrets.findMany.mockResolvedValue([{ name: "npm_token", value: "enc:v1:broken" }]);
    const { ctx, lines } = context();
    await loadBuildSecrets(ctx, APP_TOKEN);
    expect(ctx.buildSecrets).toEqual({ npm_token: APP_TOKEN });
    expect(lines[0]).toMatch(/couldn't decrypt build secret npm_token/);
  });

  it("builds on without org secrets when they can't be read", async () => {
    dbMock.query.orgBuildSecrets.findMany.mockRejectedValue(new Error("relation does not exist"));
    const { ctx, lines } = context();
    await loadBuildSecrets(ctx, APP_TOKEN);
    expect(ctx.buildSecrets).toEqual({ npm_token: APP_TOKEN });
    expect(lines[0]).toMatch(/couldn't read the org's build secrets/);
  });

  it("keeps the org value out of build args and the build key", async () => {
    orgRows([{ name: "npm_token", value: PAT }]);
    const { ctx } = context();
    await loadBuildSecrets(ctx, APP_TOKEN);
    const args = dockerfileBuildArgs({ imageName: "i", dockerfile: "/s/Dockerfile", context: "/s", loadArgs: [], envVars: { A: "1" }, secrets: ctx.buildSecrets });
    expect(args.join(" ")).not.toContain(PAT);
    expect(args).toContain("id=npm_token,env=VARDO_BUILD_SECRET_NPM_TOKEN");
    expect(buildSecretEnv(ctx.buildSecrets)).toEqual({ VARDO_BUILD_SECRET_NPM_TOKEN: PAT });
    const key = { appId: "a", gitSha: "s", rootDirectory: "", engine: "dockerfile" as const, engineVersion: "1", dockerfilePath: null, buildCommand: null, startCommand: null, buildArgs: { A: "1" }, withGitDir: false };
    expect(buildKey(key)).not.toContain(PAT);
    expect(JSON.stringify(key)).not.toContain(PAT);
  });
});
