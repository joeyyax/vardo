import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/docker/client", () => ({
  dockerRequest: vi.fn().mockResolvedValue([
    { Id: "5e1f0123456789ab", Names: ["/vardo"], Mounts: [{ Type: "volume", Name: "v" }] },
    { Id: "app", Names: ["/app-1"], Mounts: [{ Type: "volume", Name: "v" }] },
  ]),
  stopContainer: vi.fn(),
  startContainer: vi.fn(),
}));

import { containersMounting, mountTouches } from "@/lib/backups/quiesce";

describe("mountTouches", () => {
  it("matches a named volume by name only", () => {
    expect(mountTouches({ Type: "volume", Name: "a_data" }, { kind: "volume", name: "a_data" })).toBe(true);
    expect(mountTouches({ Type: "volume", Name: "b_data" }, { kind: "volume", name: "a_data" })).toBe(false);
    expect(mountTouches({ Type: "bind", Source: "a_data" }, { kind: "volume", name: "a_data" })).toBe(false);
  });

  it("matches a bind of the path or a child of it", () => {
    const dest = { kind: "bind" as const, path: "/srv/app/data/" };
    expect(mountTouches({ Type: "bind", Source: "/srv/app/data" }, dest)).toBe(true);
    expect(mountTouches({ Type: "bind", Source: "/srv/app/data/uploads" }, dest)).toBe(true);
    expect(mountTouches({ Type: "bind", Source: "/srv/app/database" }, dest)).toBe(false);
    expect(mountTouches({ Type: "bind", Source: "/srv/other" }, dest)).toBe(false);
  });

  it("leaves host-wide tools alone: parent binds and read-only mounts", () => {
    const dest = { kind: "bind" as const, path: "/srv/app/data" };
    expect(mountTouches({ Type: "bind", Source: "/srv" }, dest)).toBe(false);
    expect(mountTouches({ Type: "bind", Source: "/", RW: true }, dest)).toBe(false);
    expect(mountTouches({ Type: "volume", Name: "v", RW: false }, { kind: "volume", name: "v" })).toBe(false);
  });
});

describe("containersMounting", () => {
  it("never includes the container running this process", async () => {
    const found = await containersMounting({ kind: "volume", name: "v" }, "5e1f01234567");
    expect(found.map((c) => c.id)).toEqual(["app"]);
  });

  it("ignores a hostname that is not a container id", async () => {
    const found = await containersMounting({ kind: "volume", name: "v" }, "5e1f");
    expect(found.map((c) => c.id)).toEqual(["5e1f0123456789ab", "app"]);
  });
});
