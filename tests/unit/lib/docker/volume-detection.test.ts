import { describe, it, expect } from "vitest";
import { isAnonymousVolume } from "@/lib/docker/compose";
import { stripDockerProjectPrefix, resolveVolumeName } from "@/lib/docker/client";

// Simulates the mount filtering + name extraction logic used in deploy.ts
// post-deploy volume detection. Tests the three behavioural guarantees
// of that code path:
//
//   1. Named volumes are recorded with their project prefix stripped.
//   2. Anonymous volumes (64-char hex) are silently skipped.
//   3. Volumes with an empty name are silently skipped.

type MockMount = {
  type: string;
  destination: string;
  name: string;
  source: string;
};

function collectDetectedVolumes(mounts: MockMount[]): { name: string; mountPath: string }[] {
  const seen = new Set<string>();
  const result: { name: string; mountPath: string }[] = [];
  for (const mount of mounts) {
    if (mount.type === "volume" && !seen.has(mount.destination) && !isAnonymousVolume(mount.name)) {
      seen.add(mount.destination);
      const name = stripDockerProjectPrefix(mount.name);
      result.push({ name, mountPath: mount.destination });
    }
  }
  return result;
}

describe("deploy-time volume detection", () => {
  it("records named volumes with their project prefix stripped", () => {
    const mounts: MockMount[] = [
      { type: "volume", destination: "/data", name: "myapp-blue_data", source: "/var/lib/docker/volumes/myapp-blue_data/_data" },
    ];
    expect(collectDetectedVolumes(mounts)).toEqual([{ name: "data", mountPath: "/data" }]);
  });

  it("skips volumes with a 64-char hex name (Docker anonymous volumes)", () => {
    const hash = "a1b2c3d4".repeat(8); // 64 chars
    const mounts: MockMount[] = [
      { type: "volume", destination: "/cache", name: hash, source: `/var/lib/docker/volumes/${hash}/_data` },
    ];
    expect(collectDetectedVolumes(mounts)).toEqual([]);
  });

  it("skips volumes with an empty name", () => {
    const mounts: MockMount[] = [
      { type: "volume", destination: "/tmp/cache", name: "", source: "/var/lib/docker/volumes/abc/_data" },
    ];
    expect(collectDetectedVolumes(mounts)).toEqual([]);
  });

  it("skips bind mounts", () => {
    const mounts: MockMount[] = [
      { type: "bind", destination: "/config", name: "", source: "/host/config" },
    ];
    expect(collectDetectedVolumes(mounts)).toEqual([]);
  });

  it("deduplicates by mount destination", () => {
    const mounts: MockMount[] = [
      { type: "volume", destination: "/data", name: "myapp_data", source: "/var/lib/docker/volumes/myapp_data/_data" },
      { type: "volume", destination: "/data", name: "myapp_data", source: "/var/lib/docker/volumes/myapp_data/_data" },
    ];
    expect(collectDetectedVolumes(mounts)).toHaveLength(1);
  });

  it("handles mixed named, anonymous, and bind mounts — only named pass through", () => {
    const hash = "b".repeat(64);
    const mounts: MockMount[] = [
      { type: "volume", destination: "/data", name: "myapp_postgres", source: "/var/lib/docker/volumes/myapp_postgres/_data" },
      { type: "volume", destination: "/cache", name: hash, source: `/var/lib/docker/volumes/${hash}/_data` },
      { type: "bind", destination: "/config", name: "", source: "/host/config" },
    ];
    const result = collectDetectedVolumes(mounts);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: "postgres", mountPath: "/data" });
  });
});

// Simulates the volume name resolution used in drift-check.ts:
// resolveVolumeName() returns mount.name; isAnonymousVolume() gates
// which entries are stored for drift checking.

function collectDriftVolumes(mounts: MockMount[]): Map<string, string> {
  const dockerVolumes = new Map<string, string>();
  for (const mount of mounts) {
    if (mount.type === "volume" && !dockerVolumes.has(mount.destination)) {
      const volName = resolveVolumeName(mount);
      if (!isAnonymousVolume(volName)) {
        dockerVolumes.set(mount.destination, volName);
      }
    }
  }
  return dockerVolumes;
}

describe("drift-check volume name resolution", () => {
  it("maps mount destination to Docker volume name for named volumes", () => {
    const mounts: MockMount[] = [
      { type: "volume", destination: "/data", name: "myapp_data", source: "/var/lib/docker/volumes/myapp_data/_data" },
    ];
    expect(collectDriftVolumes(mounts).get("/data")).toBe("myapp_data");
  });

  it("does not fall back to mount.source for empty mount name", () => {
    // The host source path is not a valid Docker volume name.
    const mounts: MockMount[] = [
      { type: "volume", destination: "/data", name: "", source: "/var/lib/docker/volumes/abc/_data" },
    ];
    const result = collectDriftVolumes(mounts);
    expect(result.has("/data")).toBe(false);
  });

  it("skips anonymous volumes (64-char hex name)", () => {
    const hash = "c".repeat(64);
    const mounts: MockMount[] = [
      { type: "volume", destination: "/cache", name: hash, source: `/var/lib/docker/volumes/${hash}/_data` },
    ];
    expect(collectDriftVolumes(mounts).has("/cache")).toBe(false);
  });

  it("deduplicates by mount destination — first mount wins", () => {
    const mounts: MockMount[] = [
      { type: "volume", destination: "/data", name: "myapp_data", source: "/var/lib/docker/volumes/myapp_data/_data" },
      { type: "volume", destination: "/data", name: "other_data", source: "/var/lib/docker/volumes/other_data/_data" },
    ];
    expect(collectDriftVolumes(mounts).get("/data")).toBe("myapp_data");
  });
});
