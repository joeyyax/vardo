import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import {
  NPM_TOKEN_SECRET,
  buildSecretArgs,
  buildSecretEnv,
  composeSecretsYaml,
  resolveBuildSecrets,
  undeclaredSecrets,
  withBakeSecrets,
} from "@/lib/docker/build-secrets";

const secrets = { [NPM_TOKEN_SECRET]: "ghs_s3cret", other: "x" };

describe("build secrets", () => {
  it("names each value's env var in the flags, in id order", () => {
    expect(buildSecretArgs(secrets)).toEqual([
      "--secret", "id=npm_token,env=VARDO_BUILD_SECRET_NPM_TOKEN",
      "--secret", "id=other,env=VARDO_BUILD_SECRET_OTHER",
    ]);
    expect(buildSecretEnv(secrets)).toEqual({ VARDO_BUILD_SECRET_NPM_TOKEN: "ghs_s3cret", VARDO_BUILD_SECRET_OTHER: "x" });
  });

  it("drops empty values and ids that aren't safe in a spec or env name", () => {
    const odd = { npm_token: "", "a,b": "x", "Up": "x", "../x": "x" };
    expect(buildSecretArgs(odd)).toEqual([]);
    expect(buildSecretEnv(odd)).toEqual({});
    expect(buildSecretArgs(undefined)).toEqual([]);
  });

  it("leaves a bake definition alone without secrets", () => {
    const bake = '{"target":{"web":{}}}';
    expect(withBakeSecrets(bake, {})).toBe(bake);
  });

  it("appends to a target's own secrets", () => {
    const bake = JSON.stringify({ target: { web: { secret: ["id=mine,env=MINE"] }, api: {} } });
    const out = JSON.parse(withBakeSecrets(bake, { npm_token: "v" }));
    expect(out.target.web.secret).toEqual(["id=mine,env=MINE", "id=npm_token,env=VARDO_BUILD_SECRET_NPM_TOKEN"]);
    expect(out.target.api.secret).toEqual(["id=npm_token,env=VARDO_BUILD_SECRET_NPM_TOKEN"]);
  });

  it("writes a compose file with env-sourced secrets for the built services only", () => {
    expect(parse(composeSecretsYaml(["web"], { npm_token: "v" })!)).toEqual({
      services: { web: { build: { secrets: ["npm_token"] } } },
      secrets: { npm_token: { environment: "VARDO_BUILD_SECRET_NPM_TOKEN" } },
    });
    expect(composeSecretsYaml([], { npm_token: "v" })).toBeNull();
    expect(composeSecretsYaml(["web"], {})).toBeNull();
  });

  it("lets a compose file's own secret of the same id win", () => {
    expect(undeclaredSecrets(secrets, { npm_token: { file: "./t" } })).toEqual({ other: "x" });
    expect(undeclaredSecrets(secrets, undefined)).toEqual(secrets);
    expect(undeclaredSecrets(undefined, {})).toEqual({});
  });

  it("lets an org secret beat the GitHub App token of the same id", () => {
    expect(resolveBuildSecrets("ghs_app", { npm_token: "ghp_pat" })).toEqual({
      secrets: { npm_token: "ghp_pat" },
      sources: { npm_token: "organization" },
    });
    expect(resolveBuildSecrets("ghs_app", {})).toEqual({ secrets: { npm_token: "ghs_app" }, sources: { npm_token: "github-app" } });
    expect(resolveBuildSecrets(null, {})).toEqual({ secrets: {}, sources: {} });
  });
});
