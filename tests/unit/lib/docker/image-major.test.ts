import { describe, expect, it } from "vitest";

import {
  extractImageMajor,
  majorChanged,
  majorEnvVars,
} from "@/lib/docker/image-updates/image-major";

// Env values copied from `docker inspect` on the live host.
const PG16 = ["GOSU_VERSION=1.19", "PG_MAJOR=16", "PG_VERSION=16.14-1.pgdg13+1"];
const PG18 = ["GOSU_VERSION=1.19", "PG_MAJOR=18", "PG_VERSION=18.4-1.pgdg13+1"];
const MYSQL80 = ["GOSU_VERSION=1.19", "MYSQL_MAJOR=8.0", "MYSQL_VERSION=8.0.45-1.el9"];

describe("majorEnvVars", () => {
  it("names the engine's own version vars", () => {
    expect(majorEnvVars("postgres")).toContain("PG_MAJOR");
    expect(majorEnvVars("mysql:8.0")).toContain("MYSQL_MAJOR");
  });

  it("returns nothing for an image with no major lock", () => {
    expect(majorEnvVars("jellyfin/jellyfin:latest")).toEqual([]);
  });
});

describe("extractImageMajor", () => {
  it("reads the major from a floating tag, where the tag itself says nothing", () => {
    expect(extractImageMajor("postgres:latest", { env: PG16 })).toEqual({
      major: 16,
      source: "env",
      raw: "16",
    });
  });

  it("does not mistake an unrelated version var for the engine's", () => {
    // GOSU_VERSION=1.19 sits above PG_MAJOR in the same env block.
    expect(extractImageMajor("postgres:latest", { env: PG18 })?.major).toBe(18);
  });

  it("handles a two-part major such as MySQL 8.0", () => {
    expect(extractImageMajor("mysql:latest", { env: MYSQL80 })?.major).toBe(8);
  });

  it("falls back to the OCI version label", () => {
    const result = extractImageMajor("mongo:latest", {
      env: [],
      labels: { "org.opencontainers.image.version": "7.0.14" },
    });
    expect(result).toEqual({ major: 7, source: "label", raw: "7.0.14" });
  });

  it("returns null rather than guessing when nothing is readable", () => {
    expect(extractImageMajor("postgres:latest", { env: [], labels: {} })).toBeNull();
  });

  it("returns null for images that are not major-locked", () => {
    expect(extractImageMajor("redis:latest", { env: ["REDIS_VERSION=7.2"] })).toBeNull();
    expect(extractImageMajor("jellyfin/jellyfin:latest", { env: [] })).toBeNull();
  });
});

describe("majorChanged", () => {
  const pg16 = extractImageMajor("postgres:latest", { env: PG16 });
  const pg18 = extractImageMajor("postgres:latest", { env: PG18 });

  it("detects a floating tag rolling across a major", () => {
    expect(majorChanged(pg16, pg18)).toBe(true);
  });

  it("reports no change when the major holds", () => {
    expect(majorChanged(pg16, pg16)).toBe(false);
  });

  it("returns null — not false — when either side is unknown", () => {
    expect(majorChanged(pg16, null)).toBeNull();
    expect(majorChanged(null, pg18)).toBeNull();
  });
});
