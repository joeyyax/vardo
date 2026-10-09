import { describe, it, expect } from "vitest";
import {
  nixpacksBuildArgs,
  nixpacksPlanArgs,
  railpackBuildArgs,
  railpackPlanArgs,
} from "@/lib/docker/buildpack-args";

const overrides = { buildCommand: "npm run custom", startCommand: "node custom.js" };

describe("railpackBuildArgs", () => {
  it("keys the cache to the app and ends with the repo path", () => {
    const args = railpackBuildArgs("host/web:abc12345", "/data/web/repo", "app-1");
    expect(args).toEqual(["build", "--name", "host/web:abc12345", "--cache-key", "app-1", "/data/web/repo"]);
  });

  it("passes env vars before the repo path", () => {
    const args = railpackBuildArgs("img", "/repo", "app-1", { A: "1", B: "x=y" });
    expect(args.slice(-5)).toEqual(["--env", "A=1", "--env", "B=x=y", "/repo"]);
    expect(args).toContain("--cache-key");
  });

  it("passes overrides as --build-cmd and --start-cmd before the repo path", () => {
    const args = railpackBuildArgs("img", "/repo", "app-1", { A: "1" }, overrides);
    expect(args).toEqual([
      "build", "--name", "img", "--cache-key", "app-1",
      "--build-cmd", "npm run custom", "--start-cmd", "node custom.js",
      "--env", "A=1", "/repo",
    ]);
  });

  it("drops blank overrides, so the engine decides", () => {
    const args = railpackBuildArgs("img", "/repo", "app-1", undefined, { buildCommand: "  ", startCommand: null });
    expect(args).toEqual(["build", "--name", "img", "--cache-key", "app-1", "/repo"]);
  });
});

describe("railpackPlanArgs", () => {
  it("asks info for JSON with the same overrides and env as the build", () => {
    expect(railpackPlanArgs("/repo", { A: "1" }, overrides)).toEqual([
      "info", "--format", "json",
      "--build-cmd", "npm run custom", "--start-cmd", "node custom.js",
      "--env", "A=1", "/repo",
    ]);
    expect(railpackPlanArgs("/repo")).toEqual(["info", "--format", "json", "/repo"]);
  });
});

describe("nixpacksBuildArgs", () => {
  it("matches the args builds used before overrides existed", () => {
    expect(nixpacksBuildArgs("img", "/repo", { A: "1" })).toEqual(["build", "/repo", "--name", "img", "--env", "A=1"]);
  });

  it("passes overrides as --build-cmd and --start-cmd", () => {
    expect(nixpacksBuildArgs("img", "/repo", undefined, overrides)).toEqual([
      "build", "/repo", "--name", "img", "--build-cmd", "npm run custom", "--start-cmd", "node custom.js",
    ]);
  });

  it("keeps a lone start override without a build one", () => {
    const args = nixpacksBuildArgs("img", "/repo", undefined, { startCommand: "node custom.js" });
    expect(args).not.toContain("--build-cmd");
    expect(args.slice(-2)).toEqual(["--start-cmd", "node custom.js"]);
  });
});

describe("nixpacksPlanArgs", () => {
  it("asks plan for JSON with the same overrides and env as the build", () => {
    expect(nixpacksPlanArgs("/repo", { A: "1" }, overrides)).toEqual([
      "plan", "/repo", "--format", "json",
      "--build-cmd", "npm run custom", "--start-cmd", "node custom.js",
      "--env", "A=1",
    ]);
    expect(nixpacksPlanArgs("/repo")).toEqual(["plan", "/repo", "--format", "json"]);
  });
});
