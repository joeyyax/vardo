import { describe, it, expect } from "vitest";
import {
  declaredMountPaths,
  describeReconcile,
  isNewSlotContainer,
  planVolumeReconcile,
  type VolumeRowState,
} from "@/lib/volumes/reconcile";
import { removedVolumeReason, undeclaredVolumeReason } from "@/lib/backups/coverage";

const row = (overrides: Partial<VolumeRowState>): VolumeRowState => ({
  id: "v1",
  name: "data",
  mountPath: "/data",
  type: "named",
  source: null,
  removedAt: null,
  ...overrides,
});

describe("planVolumeReconcile", () => {
  it("turns named rows into bind rows when the compose switches to host paths", () => {
    const plan = planVolumeReconcile(
      [row({ id: "c", name: "config", mountPath: "/config" }), row({ id: "d", name: "data", mountPath: "/data" })],
      [
        { name: "config", mountPath: "/config", type: "bind", source: "/srv/app-data/config" },
        { name: "data", mountPath: "/data", type: "bind", source: "/srv/app-data/data" },
      ],
      new Set(["/config", "/data"]),
    );

    expect(plan.removals).toEqual([]);
    expect(plan.added).toEqual([]);
    expect(plan.updates.map((u) => [u.id, u.set.type, u.set.source, u.set.persistent, u.resetSelection])).toEqual([
      ["c", "bind", "/srv/app-data/config", false, true],
      ["d", "bind", "/srv/app-data/data", false, true],
    ]);
  });

  it("turns a bind row back into a named volume", () => {
    const plan = planVolumeReconcile(
      [row({ type: "bind", source: "/srv/data" })],
      [{ name: "data", mountPath: "/data", type: "named", source: null }],
      new Set(["/data"]),
    );

    expect(plan.updates[0].set).toMatchObject({ type: "named", source: null, persistent: true });
  });

  it("marks a row removed when the compose no longer declares its path", () => {
    const plan = planVolumeReconcile(
      [row({ id: "d" }), row({ id: "c", name: "cache", mountPath: "/cache" })],
      [{ name: "data", mountPath: "/data", type: "named", source: null }],
      new Set(["/data"]),
    );

    expect(plan.updates).toEqual([]);
    expect(plan.removals).toEqual([{ id: "c", name: "cache", mountPath: "/cache" }]);
    expect(describeReconcile(plan)).toBe(
      "[deploy] Volume records updated: no longer declared: cache (/cache) — backups skip them",
    );
  });

  it("keeps a row the compose still declares even when no running container mounts it", () => {
    const plan = planVolumeReconcile([row({ id: "c", name: "cache", mountPath: "/cache" })], [], new Set(["/cache"]));

    expect(plan.removals).toEqual([]);
  });

  it("removes nothing without the compose to check against", () => {
    const plan = planVolumeReconcile([row({})], [], null);

    expect(plan.removals).toEqual([]);
  });

  it("follows a named volume to its new mount path", () => {
    const plan = planVolumeReconcile(
      [row({})],
      [{ name: "data", mountPath: "/var/data", type: "named", source: null }],
      new Set(["/var/data"]),
    );

    expect(plan.updates[0]).toMatchObject({ id: "v1", set: { mountPath: "/var/data" }, resetSelection: false });
    expect(plan.added).toEqual([]);
    expect(plan.removals).toEqual([]);
  });

  it("revives a removed row that is mounted again", () => {
    const plan = planVolumeReconcile(
      [row({ removedAt: new Date() })],
      [{ name: "data", mountPath: "/data", type: "named", source: null }],
      new Set(["/data"]),
    );

    expect(plan.updates[0]).toMatchObject({ set: { removedAt: null }, resetSelection: false });
    expect(describeReconcile(plan)).toBe("[deploy] Volume records updated: data is mounted again");
  });

  it("leaves unchanged rows alone", () => {
    const plan = planVolumeReconcile(
      [row({})],
      [{ name: "data", mountPath: "/data", type: "named", source: null }],
      new Set(["/data"]),
    );

    expect(plan).toEqual({ updates: [], removals: [], added: [] });
    expect(describeReconcile(plan)).toBeNull();
  });
});

describe("declaredMountPaths", () => {
  it("collects every service's container paths", () => {
    const paths = declaredMountPaths({
      services: {
        web: { name: "web", volumes: ["data:/data", "./conf:/etc/app:ro", "/cache"] },
        db: { name: "db", volumes: ["/srv/pg:/var/lib/postgresql/data/"] },
      },
    });

    expect([...paths].sort()).toEqual(["/cache", "/data", "/etc/app", "/var/lib/postgresql/data"]);
  });
});

describe("isNewSlotContainer", () => {
  it("keeps the new slot, shared and unslotted projects", () => {
    expect(isNewSlotContainer("app-production-blue", "app-production-blue")).toBe(true);
    expect(isNewSlotContainer("app-production-green", "app-production-blue")).toBe(false);
    expect(isNewSlotContainer("app-production-shared", "app-production-blue")).toBe(true);
    expect(isNewSlotContainer("app-production", "app-production")).toBe(true);
    expect(isNewSlotContainer(undefined, "app-production-blue")).toBe(true);
  });
});

describe("backup skip reasons", () => {
  it("names the bind mount that replaced a named volume", () => {
    expect(
      undeclaredVolumeReason({ name: "config", mountPath: "/config" }, [
        { destination: "/config", type: "bind", source: "/srv/app-data/config" },
      ]),
    ).toBe(
      "No longer declared by the app — /config is now a bind mount of /srv/app-data/config. Redeploy to update its volume records",
    );
  });

  it("says nothing mounts a path the app dropped", () => {
    expect(undeclaredVolumeReason({ name: "cache", mountPath: "/cache" }, [])).toMatch(/nothing mounts \/cache/);
  });

  it("stays out of the way while a volume is mounted or nothing runs", () => {
    const mounted = [{ destination: "/data", type: "volume", source: "" }];
    expect(undeclaredVolumeReason({ name: "data", mountPath: "/data" }, mounted)).toBeNull();
    expect(undeclaredVolumeReason({ name: "data", mountPath: "/data" }, null)).toBeNull();
  });

  it("dates a removed row", () => {
    expect(
      removedVolumeReason({ name: "cache", mountPath: "/cache" }, new Date("2026-10-01T03:00:00Z")),
    ).toBe("No longer declared by the app — cache at /cache left its compose on 2026-10-01");
  });
});
