import { describe, expect, it } from "vitest";
import { effectiveKind, imageRepository, inferServiceKind } from "@/lib/ui/service-kind";

describe("imageRepository", () => {
  it("drops the registry host, tag and digest", () => {
    expect(imageRepository("ghcr.io/acme/api:1.2")).toBe("acme/api");
    expect(imageRepository("localhost:5000/api@sha256:abc")).toBe("api");
    expect(imageRepository("postgres:16-alpine")).toBe("postgres");
  });
});

describe("inferServiceKind", () => {
  it.each([
    ["postgres:17-alpine", "database"],
    ["tensorchord/vchord-postgres:pg16", "database"],
    ["getmeili/meilisearch:v1.15", "database"],
    ["mariadb:11", "database"],
    ["redis:7.4-alpine", "cache"],
    ["valkey/valkey:8-alpine", "cache"],
    ["redis/redis-stack-server:7.4", "cache"],
    ["apache/tika:3.2.1.0", "worker"],
  ])("reads %s as %s", (image, kind) => {
    expect(inferServiceKind({ image })).toBe(kind);
  });

  it("falls back to the service name for an image built from source", () => {
    expect(inferServiceKind({ image: "app-worker:local", serviceName: "worker" })).toBe("worker");
    expect(inferServiceKind({ image: null, serviceName: "queue-worker" })).toBe("worker");
  });

  it("does not match a name that only contains a keyword", () => {
    expect(inferServiceKind({ image: "acme/postgresql-exporter-ui", hasPort: true })).toBe("web");
    expect(inferServiceKind({ image: "acme/redistribute" })).toBe("other");
  });

  it("calls anything with a port web and the rest other", () => {
    expect(inferServiceKind({ image: "nginx:1.27", hasPort: true })).toBe("web");
    expect(inferServiceKind({ image: "nginx:1.27" })).toBe("other");
  });
});

describe("effectiveKind", () => {
  it("prefers the override, then the stored kind", () => {
    expect(effectiveKind({ kind: "database", kindOverride: "web" })).toBe("web");
    expect(effectiveKind({ kind: "cache", kindOverride: null, imageName: "postgres:16" })).toBe("cache");
  });

  it("infers for an app not deployed since the column existed", () => {
    expect(effectiveKind({ imageName: "redis:7", name: "stack-redis" })).toBe("cache");
  });
});
