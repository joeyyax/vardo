// #757: the container/compose import routes stored mount.source (a host path
// with slashes) as volume.name, which fails assertSafeName and silently breaks
// tar backups. volumeNameFromMount derives a safe name and never returns the
// host source path.

import { describe, it, expect } from "vitest";
import { volumeNameFromMount } from "@/lib/docker/client";

describe("volumeNameFromMount", () => {
  it("strips the compose project prefix from a named volume", () => {
    expect(
      volumeNameFromMount({
        name: "agents_redis-data",
        source: "/var/lib/docker/volumes/agents_redis-data/_data",
        destination: "/data",
        type: "volume",
      }),
    ).toBe("redis-data");
  });

  it("falls back to a path slug for an anonymous (64-hex) volume — never the host source", () => {
    const name = volumeNameFromMount({
      name: "8d9e91b1f8bbc47ae8a9656ef4a808ef94af2eeb2beb7afedfecee6eade1c143",
      source: "/var/lib/docker/volumes/8d9e91b1.../_data",
      destination: "/var/lib/postgresql/data",
      type: "volume",
    });
    expect(name).toBe("var-lib-postgresql-data");
    expect(name).not.toContain("/");
  });

  it("uses a path slug for a bind mount, not the host source", () => {
    expect(
      volumeNameFromMount({
        name: "",
        source: "/mnt/docker/gitea/data",
        destination: "/data",
        type: "bind",
      }),
    ).toBe("data");
  });

  it("never produces a name that would fail assertSafeName", () => {
    const SAFE = /^[a-zA-Z0-9._\-]+$/;
    const mounts = [
      { name: "agents_postgres-data", source: "/var/lib/docker/volumes/agents_postgres-data/_data", destination: "/var/lib/postgresql/data", type: "volume" },
      { name: "", source: "/var/run/docker.sock", destination: "/var/run/docker.sock", type: "bind" },
      { name: "a".repeat(64), source: "/var/lib/docker/volumes/x/_data", destination: "/shares", type: "volume" },
    ];
    for (const m of mounts) {
      expect(volumeNameFromMount(m)).toMatch(SAFE);
    }
  });
});
