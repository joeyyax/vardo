// #893: the restart args can't start the frontend, whatever services they are handed.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: vi.fn() }));
vi.mock("@/lib/docker/docker-env", () => ({ dockerEnv: () => ({}) }));

import { restartArgs } from "@/app/api/v1/admin/maintenance/restart/plan";

describe("restartArgs", () => {
  it("drops the frontend from the service list", () => {
    const args = restartArgs("/c.yml", ["frontend", "redis"]);

    expect(args).toEqual(["compose", "-p", "vardo", "-f", "/c.yml", "up", "-d", "--no-deps", "redis"]);
  });

  it("throws rather than run a bare `up -d` that would start the frontend", () => {
    expect(() => restartArgs("/c.yml", ["frontend"])).toThrow();
    expect(() => restartArgs("/c.yml", [])).toThrow();
  });

  it("drops names that aren't plain service names", () => {
    expect(restartArgs("/c.yml", ["--build", "redis"]).slice(-1)).toEqual(["redis"]);
  });
});
