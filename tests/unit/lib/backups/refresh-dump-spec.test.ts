import { describe, it, expect } from "vitest";
import { refreshDumpSpec } from "@/lib/backups/dump-spec";

const mount = {
  image: "postgres:17",
  mountPath: "/var/lib/postgresql/data",
  volumeName: "pgdata",
  service: "shop-db",
};

describe("refreshDumpSpec", () => {
  it("follows a renamed service", () => {
    expect(refreshDumpSpec({ kind: "postgres", service: "postgres" }, mount)).toEqual({
      kind: "postgres",
      service: "shop-db",
    });
  });

  it("follows an engine change", () => {
    const spec = refreshDumpSpec(
      { kind: "mysql", service: "shop-db" },
      { ...mount, image: "mariadb:11", mountPath: "/var/lib/mysql" },
    );
    expect(spec).toEqual({ kind: "mariadb", service: "shop-db" });
  });

  it("returns null when the spec is current", () => {
    expect(refreshDumpSpec({ kind: "postgres", service: "shop-db" }, mount)).toBeNull();
  });

  it("returns null without a spec", () => {
    expect(refreshDumpSpec(null, mount)).toBeNull();
  });

  it("ignores a non-database container on the same path", () => {
    expect(
      refreshDumpSpec({ kind: "postgres", service: "postgres" }, { ...mount, image: "alpine:3", service: "sidecar" }),
    ).toBeNull();
  });

  it("ignores a container with no service label", () => {
    expect(refreshDumpSpec({ kind: "postgres", service: "postgres" }, { ...mount, service: "" })).toBeNull();
  });
});
