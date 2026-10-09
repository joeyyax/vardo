import { describe, it, expect } from "vitest";
import { railpackBuildArgs } from "@/lib/docker/railpack-args";

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
});
