import { describe, it, expect } from "vitest";
import { bindMountHostSource, numericUid } from "@/lib/docker/deploy-steps/bind-mount-ownership";

const SLOT_DIR = "/opt/vardo/apps/myapp/production/blue";

describe("bindMountHostSource", () => {
  it("resolves absolute bind-mount sources unchanged", () => {
    expect(bindMountHostSource("/tmp/spawner:/tmp/spawner", SLOT_DIR)).toBe("/tmp/spawner");
    expect(bindMountHostSource("/data/app:/var/lib/app:ro", SLOT_DIR)).toBe("/data/app");
  });

  it("resolves relative bind-mount sources against the slot dir", () => {
    expect(bindMountHostSource("./data:/var/lib/app", SLOT_DIR)).toBe(`${SLOT_DIR}/data`);
    expect(bindMountHostSource("../shared:/shared", SLOT_DIR)).toBe("/opt/vardo/apps/myapp/production/shared");
  });

  it("returns null for named volumes", () => {
    expect(bindMountHostSource("pgdata:/var/lib/postgresql/data", SLOT_DIR)).toBeNull();
  });

  it("returns null for anonymous volumes (bare absolute path, no colon)", () => {
    expect(bindMountHostSource("/data", SLOT_DIR)).toBeNull();
  });
});

describe("numericUid", () => {
  it("extracts a plain numeric uid", () => {
    expect(numericUid("1000")).toBe("1000");
  });

  it("extracts the uid from a uid:gid spec", () => {
    expect(numericUid("1000:1000")).toBe("1000");
    expect(numericUid("1001:webgroup")).toBe("1001");
  });

  it("returns the numeric uid even for root (caller decides to skip)", () => {
    expect(numericUid("0")).toBe("0");
    expect(numericUid("0:0")).toBe("0");
  });

  it("returns null for a named user (must resolve against the image)", () => {
    expect(numericUid("worker")).toBeNull();
    expect(numericUid("appuser:appgroup")).toBeNull();
  });

  it("returns null for an empty or missing spec", () => {
    expect(numericUid(undefined)).toBeNull();
    expect(numericUid("")).toBeNull();
  });
});
