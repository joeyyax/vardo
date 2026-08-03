import { describe, it, expect } from "vitest";
import { normalizeRestartPolicy, parseDockerHealthcheck, parseExposedPorts, stripDockerProjectPrefix, resolveVolumeName, buildPruneCacheQuery, summarizeDiskUsage } from "@/lib/docker/client";
import { nanosToDuration } from "@/lib/docker/compose";

// ---------------------------------------------------------------------------
// buildPruneCacheQuery — /build/prune query string construction
//
// `all: true` is what makes this the equivalent of `docker builder prune -af`
// rather than the softer dangling-only prune used by the post-deploy step.
// ---------------------------------------------------------------------------

describe("buildPruneCacheQuery", () => {
  it("returns an empty string with no filters or options", () => {
    expect(buildPruneCacheQuery()).toBe("");
  });

  it("sets all=true when opts.all is true", () => {
    expect(buildPruneCacheQuery(undefined, { all: true })).toBe("?all=true");
  });

  it("omits all when opts.all is false", () => {
    expect(buildPruneCacheQuery(undefined, { all: false })).toBe("");
  });

  it("encodes filters as JSON", () => {
    const query = buildPruneCacheQuery({ until: ["168h"] });
    expect(query).toBe(`?filters=${encodeURIComponent(JSON.stringify({ until: ["168h"] }))}`);
  });

  it("combines filters and all", () => {
    const query = buildPruneCacheQuery({ until: ["24h"] }, { all: true });
    expect(query).toContain("all=true");
    expect(query).toContain(encodeURIComponent(JSON.stringify({ until: ["24h"] })));
  });
});

describe("normalizeRestartPolicy", () => {
  it("returns 'no' when name is empty", () => {
    expect(normalizeRestartPolicy("", 0)).toBe("no");
  });

  it("returns the policy name unchanged for non-on-failure policies", () => {
    expect(normalizeRestartPolicy("always", 0)).toBe("always");
    expect(normalizeRestartPolicy("unless-stopped", 0)).toBe("unless-stopped");
    expect(normalizeRestartPolicy("no", 0)).toBe("no");
  });

  it("returns 'on-failure:N' when name is on-failure and maxRetryCount > 0", () => {
    expect(normalizeRestartPolicy("on-failure", 3)).toBe("on-failure:3");
    expect(normalizeRestartPolicy("on-failure", 1)).toBe("on-failure:1");
  });

  it("returns 'on-failure' without suffix when maxRetryCount is 0", () => {
    expect(normalizeRestartPolicy("on-failure", 0)).toBe("on-failure");
  });
});

describe("parseDockerHealthcheck", () => {
  it("returns null when healthcheck is null", () => {
    expect(parseDockerHealthcheck(null)).toBeNull();
  });

  it("returns null when healthcheck is undefined", () => {
    expect(parseDockerHealthcheck(undefined)).toBeNull();
  });

  it("returns null when Test array is absent", () => {
    expect(parseDockerHealthcheck({})).toBeNull();
  });

  it("returns null when Test[0] is NONE (disabled healthcheck)", () => {
    expect(parseDockerHealthcheck({ Test: ["NONE"] })).toBeNull();
  });

  it("returns parsed healthcheck when Test is a real command", () => {
    const result = parseDockerHealthcheck({
      Test: ["CMD", "curl", "-f", "http://localhost/"],
      Interval: 30_000_000_000,
      Timeout: 10_000_000_000,
      Retries: 3,
      StartPeriod: 5_000_000_000,
    });
    expect(result).toEqual({
      test: ["CMD", "curl", "-f", "http://localhost/"],
      interval: 30_000_000_000,
      timeout: 10_000_000_000,
      retries: 3,
      startPeriod: 5_000_000_000,
    });
  });

  it("fills in zeros for missing timing fields", () => {
    const result = parseDockerHealthcheck({ Test: ["CMD-SHELL", "exit 0"] });
    expect(result).toEqual({ test: ["CMD-SHELL", "exit 0"], interval: 0, timeout: 0, retries: 0, startPeriod: 0 });
  });
});

describe("nanosToDuration", () => {
  it("returns minutes for exact minute values", () => {
    expect(nanosToDuration(60_000_000_000)).toBe("1m");
    expect(nanosToDuration(120_000_000_000)).toBe("2m");
  });

  it("returns seconds for exact second values", () => {
    expect(nanosToDuration(30_000_000_000)).toBe("30s");
    expect(nanosToDuration(1_000_000_000)).toBe("1s");
  });

  it("returns milliseconds for exact millisecond values", () => {
    expect(nanosToDuration(500_000_000)).toBe("500ms");
  });

  it("falls back to rounded seconds for sub-millisecond or fractional values", () => {
    // 1.5s — not an integer number of ms or s, not a whole minute
    expect(nanosToDuration(1_500_000_001)).toBe("2s");
  });
});

describe("parseExposedPorts", () => {
  it("parses a single 'port/protocol' key to a number", () => {
    expect(parseExposedPorts({ "80/tcp": {} })).toEqual([80]);
  });

  it("parses multiple ports and preserves order", () => {
    expect(parseExposedPorts({ "80/tcp": {}, "443/tcp": {}, "8080/tcp": {} })).toEqual([80, 443, 8080]);
  });

  it("filters out keys that do not start with a valid port number", () => {
    expect(parseExposedPorts({ "invalid/tcp": {}, "80/tcp": {} })).toEqual([80]);
  });

  it("returns empty array for null", () => {
    expect(parseExposedPorts(null)).toEqual([]);
  });

  it("returns empty array for undefined", () => {
    expect(parseExposedPorts(undefined)).toEqual([]);
  });
});


describe("stripDockerProjectPrefix", () => {
  it("strips the project prefix from a namespaced volume name", () => {
    expect(stripDockerProjectPrefix("myapp-blue_data")).toBe("data");
    expect(stripDockerProjectPrefix("myapp-green_postgres")).toBe("postgres");
  });

  it("strips only the first segment up to the first underscore", () => {
    // volume names with multiple underscores: only the leading prefix is removed
    expect(stripDockerProjectPrefix("myapp-blue_redis_data")).toBe("redis_data");
  });

  it("returns the original name when there is no underscore", () => {
    expect(stripDockerProjectPrefix("data")).toBe("data");
    expect(stripDockerProjectPrefix("postgres")).toBe("postgres");
  });

  it("returns empty string for an empty input", () => {
    expect(stripDockerProjectPrefix("")).toBe("");
  });

  it("handles names that start with an underscore (edge case)", () => {
    // The regex removes everything up to and including the first underscore,
    // so a leading underscore removes just that character.
    expect(stripDockerProjectPrefix("_data")).toBe("data");
  });
});

describe("resolveVolumeName", () => {
  it("returns mount.name for a named volume", () => {
    const mount = { name: "myapp-blue_data", source: "/var/lib/docker/volumes/myapp-blue_data/_data" };
    expect(resolveVolumeName(mount)).toBe("myapp-blue_data");
  });

  it("returns empty string when name is empty — does not fall back to mount.source", () => {
    // mount.source is a host path, not a valid volume name; callers should skip
    // empty results rather than using the source path.
    const mount = { name: "", source: "/var/lib/docker/volumes/abc123/_data" };
    expect(resolveVolumeName(mount)).toBe("");
  });

  it("returns mount.name regardless of source value", () => {
    const mount = { name: "explicit-name", source: "/some/source/path" };
    expect(resolveVolumeName(mount)).toBe("explicit-name");
  });

  it("returns the 64-char hash name for a Docker anonymous volume", () => {
    // Anonymous volumes carry a hash name — callers should use isAnonymousVolume()
    // to decide whether to skip.
    const hash = "a".repeat(64);
    const mount = { name: hash, source: `/var/lib/docker/volumes/${hash}/_data` };
    expect(resolveVolumeName(mount)).toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// summarizeDiskUsage — the arithmetic behind `docker system df`
//
// Both image figures are approximations Docker itself makes. The point is that
// they match what an operator sees running the command, rather than being a
// second and larger opinion. Verified figure for figure against a live host.
// ---------------------------------------------------------------------------

describe("summarizeDiskUsage", () => {
  function image(over: Partial<{ Size: number; SharedSize: number; Containers: number }> = {}) {
    return { Id: "sha256:x", Size: 0, SharedSize: 0, Containers: 0, ...over };
  }

  it("reports what images occupy, not the sum of their sizes", () => {
    // Two images sharing a 90-byte layer occupy 110 bytes between them, not 200.
    const usage = summarizeDiskUsage({
      LayersSize: 110,
      Images: [
        image({ Size: 100, SharedSize: 90, Containers: 1 }),
        image({ Size: 100, SharedSize: 90, Containers: 1 }),
      ],
    });
    expect(usage.images.totalSize).toBe(110);
  });

  it("charges only the bytes an idle image holds on its own", () => {
    // 90 of the idle image's 100 bytes are shared with the running one, so
    // removing it frees 10 and the other 100 stay put.
    const usage = summarizeDiskUsage({
      LayersSize: 110,
      Images: [
        image({ Size: 100, SharedSize: 90, Containers: 1 }),
        image({ Size: 100, SharedSize: 90, Containers: 0 }),
      ],
    });
    expect(usage.images.reclaimable).toBe(100);
  });

  it("never reports more reclaimable than images occupy", () => {
    const usage = summarizeDiskUsage({
      LayersSize: 110,
      Images: [image({ Size: 100, SharedSize: 90, Containers: 0 })],
    });
    expect(usage.images.reclaimable).toBeLessThanOrEqual(usage.images.totalSize);
  });

  it("clamps at zero when Docker's shared-layer accounting overshoots the total", () => {
    const usage = summarizeDiskUsage({
      LayersSize: 100,
      Images: [image({ Size: 500, SharedSize: 0, Containers: 0 })],
    });
    expect(usage.images.reclaimable).toBe(0);
  });

  it("reproduces the live host's `docker system df` images row", () => {
    // Aggregates measured on the production host, where the CLI prints
    // 107.4GB total and 41.75GB (38%) reclaimable.
    const usage = summarizeDiskUsage({
      LayersSize: 107_357_323_923,
      Images: [
        image({ Size: 65_604_557_160, SharedSize: 0, Containers: 0 }),
        image({ Size: 1_000, SharedSize: 1_000, Containers: 1 }),
      ],
    });
    expect(usage.images.totalSize).toBe(107_357_323_923);
    expect(usage.images.reclaimable).toBe(41_752_766_763);
  });

  it("leaves out build cache records whose blobs an image still holds", () => {
    const usage = summarizeDiskUsage({
      BuildCache: [
        { ID: "a", Size: 100, InUse: false, Shared: false },
        { ID: "b", Size: 200, InUse: false, Shared: true },
        { ID: "c", Size: 400, InUse: true, Shared: false },
      ],
    });
    expect(usage.buildCache.totalSize).toBe(700);
    expect(usage.buildCache.reclaimable).toBe(100);
  });

  it("counts container writable layers and volume usage", () => {
    const usage = summarizeDiskUsage({
      Containers: [{ Id: "a", SizeRw: 50, SizeRootFs: 0 }],
      Volumes: [{ Name: "v", UsageData: { Size: 25, RefCount: 0 } }],
    });
    expect(usage.containers.totalSize).toBe(50);
    expect(usage.volumes.totalSize).toBe(25);
  });

  it("survives a response with every section missing", () => {
    const usage = summarizeDiskUsage({});
    expect(usage.total).toBe(0);
    expect(usage.images.reclaimable).toBe(0);
  });

  it("totals the four sections", () => {
    const usage = summarizeDiskUsage({
      LayersSize: 100,
      Images: [image({ Size: 100, SharedSize: 0, Containers: 1 })],
      Containers: [{ Id: "a", SizeRw: 10, SizeRootFs: 0 }],
      Volumes: [{ Name: "v", UsageData: { Size: 5, RefCount: 1 } }],
      BuildCache: [{ ID: "a", Size: 2, InUse: true, Shared: false }],
    });
    expect(usage.total).toBe(117);
  });
});

