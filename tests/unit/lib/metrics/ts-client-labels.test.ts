import { describe, it, expect, beforeEach, vi } from "vitest";

const calls = vi.hoisted(() => {
  const recorded: string[][] = [];
  const existing = new Set<string>();
  return { recorded, existing };
});

vi.mock("ioredis", () => ({
  default: class {
    async call(...args: string[]) {
      calls.recorded.push(args);
      if (args[0] === "TS.CREATE" && calls.existing.has(args[1])) {
        throw new Error("TSDB: key already exists");
      }
      return "OK";
    }
  },
}));

import { ensureTimeSeries } from "@/lib/metrics/ts-client";

describe("ensureTimeSeries", () => {
  beforeEach(() => {
    calls.recorded.length = 0;
    calls.existing.clear();
  });

  it("creates a new key with its labels", async () => {
    await ensureTimeSeries("metrics:a:cpu:c1", { project: "a", service: "web" });

    expect(calls.recorded[0][0]).toBe("TS.CREATE");
    expect(calls.recorded.some((c) => c[0] === "TS.ALTER")).toBe(false);
  });

  it("backfills labels onto a key written before the label existed", async () => {
    calls.existing.add("metrics:a:cpu:c2");

    await ensureTimeSeries("metrics:a:cpu:c2", { project: "a", service: "web" });

    const alter = calls.recorded.find((c) => c[0] === "TS.ALTER");
    expect(alter).toEqual(["TS.ALTER", "metrics:a:cpu:c2", "LABELS", "project", "a", "service", "web"]);
  });
});
