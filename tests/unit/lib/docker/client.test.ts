import { describe, it, expect } from "vitest";
import { normalizeRestartPolicy, parseDockerHealthcheck, stripDockerProjectPrefix, resolveVolumeName, parseExposedPorts } from "@/lib/docker/client";
import { nanosToDuration } from "@/lib/docker/compose";

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

describe("parseExposedPorts", () => {
  it("parses a single tcp port", () => {
    expect(parseExposedPorts({ "8080/tcp": {} })).toEqual([8080]);
  });

  it("parses multiple ports", () => {
    expect(parseExposedPorts({ "80/tcp": {}, "443/tcp": {}, "8080/tcp": {} })).toEqual([80, 443, 8080]);
  });

  it("parses udp ports", () => {
    expect(parseExposedPorts({ "53/udp": {} })).toEqual([53]);
  });

  it("returns empty array for null", () => {
    expect(parseExposedPorts(null)).toEqual([]);
  });

  it("returns empty array for undefined", () => {
    expect(parseExposedPorts(undefined)).toEqual([]);
  });

  it("returns empty array for empty object", () => {
    expect(parseExposedPorts({})).toEqual([]);
  });

  it("filters out non-numeric entries", () => {
    expect(parseExposedPorts({ "notaport/tcp": {} })).toEqual([]);
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

