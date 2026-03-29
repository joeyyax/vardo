import { describe, it, expect } from "vitest";
import { normalizeRestartPolicy, parseDockerHealthcheck, stripDockerProjectPrefix, resolveVolumeName } from "@/lib/docker/client";
import { nanosToDuration, isAnonymousVolume } from "@/lib/docker/compose";

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

describe("isAnonymousVolume", () => {
  it("returns false for a named volume", () => {
    expect(isAnonymousVolume("myapp-blue_data")).toBe(false);
  });

  it("returns true for an empty string", () => {
    expect(isAnonymousVolume("")).toBe(true);
  });

  it("returns true for a 64-character lowercase hex hash (Docker anonymous volume id)", () => {
    const hash = "a1b2c3d4".repeat(8); // 64 chars
    expect(isAnonymousVolume(hash)).toBe(true);
  });

  it("returns false for a string that is 64 chars but not all hex", () => {
    // Docker hashes are strictly lowercase hex; anything else is a named volume
    const notHex = "z".repeat(64);
    expect(isAnonymousVolume(notHex)).toBe(false);
  });

  it("returns false for a 63-char hex string (one short)", () => {
    const shortHash = "a".repeat(63);
    expect(isAnonymousVolume(shortHash)).toBe(false);
  });

  it("returns false for a 65-char hex string (one long)", () => {
    const longHash = "a".repeat(65);
    expect(isAnonymousVolume(longHash)).toBe(false);
  });
});
