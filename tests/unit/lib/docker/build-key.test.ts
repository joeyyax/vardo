import { describe, it, expect } from "vitest";
import { buildArgsHash, buildKey, findReusableImage, type BuildKeyInput } from "@/lib/docker/build-key";
import { dockerfileBuildArgs } from "@/lib/docker/buildpack-args";

const base: BuildKeyInput = {
  appId: "app-1",
  gitSha: "a".repeat(40),
  rootDirectory: "",
  engine: "dockerfile",
  engineVersion: "29.4.0",
  dockerfilePath: null,
  buildCommand: null,
  startCommand: null,
  buildArgs: { NEXT_PUBLIC_API: "https://api.example.com", DATABASE_URL: "postgres://db" },
  withGitDir: false,
};

describe("buildKey", () => {
  it("is a stable hex digest of its inputs", () => {
    expect(buildKey(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(buildKey({ ...base })).toBe(buildKey(base));
  });

  it("ignores arg order and spelling that doesn't change the build", () => {
    expect(buildKey({ ...base, buildArgs: { DATABASE_URL: "postgres://db", NEXT_PUBLIC_API: "https://api.example.com" } })).toBe(buildKey(base));
    expect(buildKey({ ...base, rootDirectory: "./" })).toBe(buildKey(base));
    expect(buildKey({ ...base, dockerfilePath: "Dockerfile" })).toBe(buildKey(base));
    expect(buildKey({ ...base, buildCommand: "  " })).toBe(buildKey(base));
  });

  it.each<[string, Partial<BuildKeyInput>]>([
    ["app", { appId: "app-2" }],
    ["commit", { gitSha: "b".repeat(40) }],
    ["root directory", { rootDirectory: "apps/web" }],
    ["engine", { engine: "railpack" }],
    ["engine version", { engineVersion: "29.5.0" }],
    ["Dockerfile path", { dockerfilePath: "docker/Dockerfile.prod" }],
    ["build command", { buildCommand: "npm run build:prod" }],
    ["start command", { startCommand: "node server.js" }],
    ["a baked-in value", { buildArgs: { ...base.buildArgs, NEXT_PUBLIC_API: "https://api2.example.com" } }],
    ["a runtime-only value", { buildArgs: { ...base.buildArgs, DATABASE_URL: "postgres://other" } }],
    ["an added var", { buildArgs: { ...base.buildArgs, NEW: "1" } }],
    ["a removed var", { buildArgs: { NEXT_PUBLIC_API: "https://api.example.com" } }],
    [".git in the context", { withGitDir: true }],
  ])("changes with the %s", (_name, change) => {
    expect(buildKey({ ...base, ...change })).not.toBe(buildKey(base));
  });

  it("drops the Dockerfile path for buildpack engines", () => {
    const railpack = { ...base, engine: "railpack" as const };
    expect(buildKey({ ...railpack, dockerfilePath: "Other" })).toBe(buildKey(railpack));
  });

  it("never carries a value in the clear", () => {
    expect(buildArgsHash({ SECRET: "hunter2" })).not.toContain("hunter2");
  });
});

describe("findReusableImage", () => {
  it("takes the newest candidate still on the host", async () => {
    const present = new Set(["host/shop:old2"]);
    const found = await findReusableImage(
      [{ id: "new", image: "host/shop:new" }, { id: "old2", image: "host/shop:old2" }, { id: "old3", image: "host/shop:old3" }],
      async (image) => present.has(image),
    );
    expect(found?.id).toBe("old2");
  });

  it("returns null when every image is gone", async () => {
    expect(await findReusableImage([{ id: "a", image: "x" }], async () => false)).toBeNull();
  });
});

describe("dockerfileBuildArgs", () => {
  const opts = {
    imageName: "host/shop:abc",
    dockerfile: "/src/Dockerfile",
    context: "/src",
    loadArgs: ["--load"],
    envVars: { A: "1" },
  };

  it("passes every env var as a build arg, labels the key and adds the commit", () => {
    expect(dockerfileBuildArgs({ ...opts, buildKey: "k1", gitSha: "abc" })).toEqual([
      "build", "--load", "--progress=plain", "-t", "host/shop:abc", "-f", "/src/Dockerfile",
      "--label", "vardo.build.key=k1",
      "--build-arg", "A=1",
      "--build-arg", "VARDO_GIT_SHA=abc",
      "/src",
    ]);
  });

  it("keeps an env VARDO_GIT_SHA and adds --no-cache when asked", () => {
    const args = dockerfileBuildArgs({ ...opts, envVars: { VARDO_GIT_SHA: "mine" }, gitSha: "abc", noCache: true });
    expect(args).toContain("--no-cache");
    expect(args.filter((a) => a.startsWith("VARDO_GIT_SHA="))).toEqual(["VARDO_GIT_SHA=mine"]);
  });
});
