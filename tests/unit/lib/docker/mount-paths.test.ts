import { describe, it, expect } from "vitest";
import {
  assertSafeBindSource,
  deniedMountReason,
  resolveBothWays,
  DENIED_MOUNT_PATHS,
  DENIED_BACKUP_PATHS,
  UnsafeMountPathError,
} from "@/lib/docker/mount-paths";

describe("the two lists are not the same list", () => {
  it("keeps compose narrow, so mounting a host binary still works", () => {
    // Mounting the host docker binary into a container is an ordinary pattern.
    // Widening the compose list would break any app doing it.
    expect(deniedMountReason("/usr/bin/docker", DENIED_MOUNT_PATHS)).toBeNull();
  });

  it("refuses the same path for backup, where the verb is 'restore over'", () => {
    expect(deniedMountReason("/usr/bin/docker", DENIED_BACKUP_PATHS)).toBe("/usr");
  });

  it("leaves ordinary application locations alone", () => {
    for (const p of ["/srv/app/data", "/var/lib/myapp", "/home/someone/appdata", "/opt/stack/data"]) {
      expect(deniedMountReason(p, DENIED_BACKUP_PATHS)).toBeNull();
    }
  });
});

describe("resolveBothWays", () => {
  it("gives a traversal both readings, since one alone is bypassable", () => {
    const [, rootResolved] = resolveBothWays("../../../var/run/docker.sock");
    expect(rootResolved).toBe("/var/run/docker.sock");
  });
});

describe("assertSafeBindSource", () => {
  it("accepts a real application path and returns it normalized", () => {
    expect(assertSafeBindSource("/srv/app/data")).toBe("/srv/app/data");
    expect(assertSafeBindSource("/srv//app/./uploads")).toBe("/srv/app/uploads");
  });

  it("refuses a relative value, which Docker would read as a volume name", () => {
    // `-v data:/data` mounts a named volume called "data". Silently backing up
    // or restoring over the wrong thing entirely.
    expect(() => assertSafeBindSource("data")).toThrow(/volume name/);
    expect(() => assertSafeBindSource("./data")).toThrow(/absolute/);
  });

  it("refuses a colon, which restructures the -v argument", () => {
    expect(() => assertSafeBindSource("/srv/data:/etc")).toThrow(/colon/);
    expect(() => assertSafeBindSource("/srv/data:ro")).toThrow(/colon/);
  });

  it("refuses a parent-directory segment", () => {
    expect(() => assertSafeBindSource("/srv/../etc")).toThrow(/parent-directory/);
    expect(() => assertSafeBindSource("/srv/app/../../root")).toThrow(/parent-directory/);
  });

  it("refuses the host root outright", () => {
    expect(() => assertSafeBindSource("/")).toThrow(UnsafeMountPathError);
  });

  it("refuses the paths that would end the host on restore", () => {
    for (const p of ["/etc", "/etc/ssh", "/usr", "/usr/lib", "/boot", "/dev", "/var/lib/docker", "/root"]) {
      expect(() => assertSafeBindSource(p), p).toThrow(/must never be archived or restored over/);
    }
  });

  it("refuses the Docker socket by either conventional path", () => {
    expect(() => assertSafeBindSource("/var/run/docker.sock")).toThrow(UnsafeMountPathError);
  });

  it("refuses the live Docker data-root when told what it is", () => {
    // The real root is read from the daemon rather than assumed to be
    // /var/lib/docker; a host may keep it on a separate pool.
    expect(() => assertSafeBindSource("/pool/docker/overlay2", { dockerRoot: "/pool/docker" })).toThrow(
      /must never be/,
    );
    expect(assertSafeBindSource("/pool/appdata", { dockerRoot: "/pool/docker" })).toBe("/pool/appdata");
  });

  it("refuses empty and whitespace", () => {
    expect(() => assertSafeBindSource("")).toThrow(/empty/);
    expect(() => assertSafeBindSource("   ")).toThrow(/empty/);
  });

  it("names the source in the error, so an operator can see which volume", () => {
    expect(() => assertSafeBindSource("/etc", { label: "app data" })).toThrow(/app data "\/etc"/);
  });

  it("does not let a denied prefix match a sibling directory", () => {
    // "/etcetera" is not under "/etc".
    expect(assertSafeBindSource("/etcetera/data")).toBe("/etcetera/data");
    expect(assertSafeBindSource("/usr-local/data")).toBe("/usr-local/data");
  });
});
