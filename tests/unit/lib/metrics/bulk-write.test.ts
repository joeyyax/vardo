import { beforeEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => ({ set: vi.fn(), exists: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/redis", () => ({ redis }));

import { isBulkWriteRunning, isBulkWriting, withBulkWrite } from "@/lib/metrics/bulk-write";

beforeEach(() => {
  vi.clearAllMocks();
  redis.set.mockResolvedValue("OK");
});

describe("withBulkWrite", () => {
  it("marks the app while running and keeps a 15 minute marker after", async () => {
    await withBulkWrite("app1", async () => {
      expect(redis.set).toHaveBeenLastCalledWith("vardo:bulk-write:app1", "running", "EX", 6 * 3600);
    });
    expect(redis.set).toHaveBeenLastCalledWith("vardo:bulk-write:app1", "done", "EX", 900);
  });

  it("keeps the cooldown marker when the run throws", async () => {
    await expect(withBulkWrite("app1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(redis.set).toHaveBeenLastCalledWith("vardo:bulk-write:app1", "done", "EX", 900);
  });

  it("runs without an app id", async () => {
    expect(await withBulkWrite(null, async () => 7)).toBe(7);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("runs when redis is down", async () => {
    redis.set.mockRejectedValue(new Error("down"));
    expect(await withBulkWrite("app1", async () => 7)).toBe(7);
  });
});

describe("isBulkWriting", () => {
  it("is true when any key exists", async () => {
    redis.exists.mockResolvedValue(1);
    expect(await isBulkWriting(["a", null, "b"])).toBe(true);
    expect(redis.exists).toHaveBeenCalledWith("vardo:bulk-write:a", "vardo:bulk-write:b");
  });

  it("is false with no ids or when redis is down", async () => {
    expect(await isBulkWriting([null])).toBe(false);
    redis.exists.mockRejectedValue(new Error("down"));
    expect(await isBulkWriting(["a"])).toBe(false);
  });
});

describe("isBulkWriteRunning", () => {
  it("is true only while the run holds the marker", async () => {
    redis.get.mockResolvedValueOnce("running").mockResolvedValueOnce("done").mockResolvedValueOnce(null);
    expect(await isBulkWriteRunning("a")).toBe(true);
    expect(await isBulkWriteRunning("a")).toBe(false);
    expect(await isBulkWriteRunning("a")).toBe(false);
  });

  it("is false when redis is down", async () => {
    redis.get.mockRejectedValue(new Error("down"));
    expect(await isBulkWriteRunning("a")).toBe(false);
  });
});
