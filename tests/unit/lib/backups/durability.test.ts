import { describe, it, expect } from "vitest";
import {
  isBackupCandidate,
  exclusionReason,
  proposeDurability,
  isSafeToApply,
} from "@/lib/backups/durability";

describe("isBackupCandidate", () => {
  it("captures an unclassified volume, exactly as before durability existed", () => {
    expect(isBackupCandidate(null)).toBe(true);
    expect(isBackupCandidate(undefined)).toBe(true);
  });

  it("captures stateful", () => {
    expect(isBackupCandidate("stateful")).toBe(true);
  });

  it("leaves out what reconstructs itself or lives elsewhere", () => {
    expect(isBackupCandidate("rebuildable")).toBe(false);
    expect(isBackupCandidate("external")).toBe(false);
  });
});

describe("exclusionReason", () => {
  it("has nothing to say about a volume that gets captured", () => {
    expect(exclusionReason(null)).toBeNull();
    expect(exclusionReason("stateful")).toBeNull();
  });

  it("explains each exclusion", () => {
    expect(exclusionReason("rebuildable")).toMatch(/reconstructed/i);
    expect(exclusionReason("external")).toMatch(/outside this volume/i);
  });
});

describe("proposeDurability — databases", () => {
  it("reads a postgres data directory", () => {
    const p = proposeDurability({ image: "postgres:16", mountPath: "/var/lib/postgresql/data" });
    expect(p).toMatchObject({ durability: "stateful", kind: "postgres" });
  });

  it("covers the postgres forks that ship their own image name", () => {
    for (const image of ["postgis/postgis:16-3.4", "timescale/timescaledb:latest", "pgvector/pgvector:pg16"]) {
      expect(proposeDurability({ image, mountPath: "/var/lib/postgresql/data" })).toMatchObject({
        durability: "stateful",
        kind: "postgres",
      });
    }
  });

  it("tells mariadb from mysql, since they share a data directory", () => {
    expect(proposeDurability({ image: "mariadb:11", mountPath: "/var/lib/mysql" })).toMatchObject({ kind: "mariadb" });
    expect(proposeDurability({ image: "mysql:8", mountPath: "/var/lib/mysql" })).toMatchObject({ kind: "mysql" });
  });

  it("reads mongo", () => {
    expect(proposeDurability({ image: "mongo:7", mountPath: "/data/db" })).toMatchObject({
      durability: "stateful",
      kind: "mongo",
    });
  });

  it("does not claim a database image's other mounts are its data", () => {
    expect(proposeDurability({ image: "postgres:16", mountPath: "/backups" })).toBeNull();
    expect(proposeDurability({ image: "postgres:16", mountPath: "/docker-entrypoint-initdb.d" })).toBeNull();
  });

  it("judges on the image, so a path alone proposes nothing", () => {
    expect(proposeDurability({ image: "alpine", mountPath: "/var/lib/postgresql/data" })).toBeNull();
  });

  it("matches the image with no mount path to corroborate", () => {
    expect(proposeDurability({ image: "postgres:16" })).toMatchObject({ kind: "postgres" });
  });
});

describe("proposeDurability — rebuildable", () => {
  it("reads caches from either the path or the name", () => {
    expect(proposeDurability({ mountPath: "/var/cache/lonvr" })).toMatchObject({ durability: "rebuildable" });
    expect(proposeDurability({ volumeName: "reeve_cache" })).toMatchObject({ durability: "rebuildable" });
  });

  it("reads re-issuable certificates", () => {
    expect(proposeDurability({ volumeName: "letsencrypt" })).toMatchObject({ durability: "rebuildable" });
    expect(proposeDurability({ mountPath: "/acme" })).toMatchObject({ durability: "rebuildable" });
  });

  it("reads build caches and shipper positions", () => {
    expect(proposeDurability({ volumeName: "buildkit_data" })).toMatchObject({ durability: "rebuildable" });
    expect(proposeDurability({ volumeName: "promtail-positions" })).toMatchObject({ durability: "rebuildable" });
  });

  it("does not fire on a word that merely contains one of them", () => {
    // "cached" and "cachet" are not "cache"; a substring match would lose data.
    expect(proposeDurability({ volumeName: "cachet-data" })).toBeNull();
    expect(proposeDurability({ mountPath: "/var/lib/apcupsd" })).toBeNull();
  });

  it("prefers the database reading when a database also looks cacheable", () => {
    const p = proposeDurability({
      image: "postgres:16",
      mountPath: "/var/lib/postgresql/data",
      volumeName: "pg-cache",
    });
    expect(p).toMatchObject({ durability: "stateful" });
  });
});

describe("proposeDurability — silence", () => {
  it("says nothing rather than guessing", () => {
    expect(proposeDurability({})).toBeNull();
    expect(proposeDurability({ image: "nginx:alpine", mountPath: "/usr/share/nginx/html" })).toBeNull();
    expect(proposeDurability({ image: "redis:8-alpine", mountPath: "/data" })).toBeNull();
  });

  it("leaves redis alone — a cache and a datastore are the same image", () => {
    expect(proposeDurability({ image: "redis:alpine", mountPath: "/data" })).toBeNull();
  });
});

describe("isSafeToApply", () => {
  it("writes a stateful proposal onto an unclassified volume", () => {
    expect(isSafeToApply(null, "stateful")).toBe(true);
    expect(isSafeToApply(undefined, "stateful")).toBe(true);
  });

  it("never writes a downgrade unprompted", () => {
    expect(isSafeToApply(null, "rebuildable")).toBe(false);
    expect(isSafeToApply(null, "external")).toBe(false);
  });

  it("never overrides a decision somebody already made", () => {
    expect(isSafeToApply("rebuildable", "stateful")).toBe(false);
    expect(isSafeToApply("external", "stateful")).toBe(false);
    expect(isSafeToApply("stateful", "stateful")).toBe(false);
  });
});
