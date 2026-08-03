import { describe, it, expect } from "vitest";
import {
  reading,
  notCollected,
  percentOfLimit,
  type ResourceReading,
} from "@/lib/metrics/resource-types";

describe("reading", () => {
  it("marks a reading with no usage as absent rather than zero", () => {
    const r = reading({ kind: "disk", unit: "bytes", usage: null, absence: "not-collected" });

    expect(r.usage).toBeNull();
    expect(r.absence).toBe("not-collected");
    expect(r.percent).toBeNull();
  });

  it("keeps a measured zero as a number", () => {
    const r = reading({ kind: "cpu", unit: "percent", usage: 0, limit: 400, limitKind: "enforced" });

    expect(r.usage).toBe(0);
    expect(r.absence).toBeNull();
    expect(r.percent).toBe(0);
  });

  it("clears absence once a usage number is present", () => {
    const r = reading({ kind: "memory", unit: "bytes", usage: 512, absence: "stale" });

    expect(r.absence).toBeNull();
  });

  it("defaults absence when usage is missing and none was given", () => {
    expect(reading({ kind: "gpu", unit: "percent" }).absence).toBe("not-collected");
  });

  it("drops a limit stated alongside limitKind none", () => {
    const r = reading({ kind: "network", unit: "bytesPerSecond", usage: 10, limit: 99, limitKind: "none" });

    expect(r.limit).toBeNull();
    expect(r.percent).toBeNull();
  });
});

describe("percentOfLimit", () => {
  it("derives a percentage against an enforced limit", () => {
    expect(percentOfLimit(256, 1024, "enforced")).toBe(25);
  });

  it("derives a percentage against a shared capacity", () => {
    expect(percentOfLimit(50, 3200, "capacity")).toBe(1.56);
  });

  it("returns null when the limit is unknown", () => {
    expect(percentOfLimit(256, 1024, "unknown")).toBeNull();
  });

  it("returns null when there is no limit", () => {
    expect(percentOfLimit(256, null, "none")).toBeNull();
  });

  it("returns null when usage is absent", () => {
    expect(percentOfLimit(null, 1024, "enforced")).toBeNull();
  });

  it("returns null for a zero limit rather than dividing by it", () => {
    expect(percentOfLimit(10, 0, "enforced")).toBeNull();
  });
});

// The bug this guards: a metric nobody collects rendering as "0 B" or "0%".
// Any reading without a usage number must be unformattable as a quantity.
describe("absent readings never look like zero", () => {
  const absent: ResourceReading[] = [
    notCollected("disk", "bytes"),
    notCollected("gpu", "percent"),
    notCollected("diskWrite", "bytesPerSecond", "unsupported"),
    reading({ kind: "network", unit: "bytesPerSecond", usage: null, absence: "stale" }),
  ];

  it.each(absent)("$kind/$absence carries no usage, no percent and no limit", (r) => {
    expect(r.usage).toBeNull();
    expect(r.percent).toBeNull();
    expect(r.absence).not.toBeNull();
    expect(r.usage).not.toBe(0);
    expect(r.percent).not.toBe(0);
  });

  it("survives JSON transport without becoming zero", () => {
    const wire = JSON.parse(JSON.stringify(notCollected("disk", "bytes"))) as ResourceReading;

    expect(wire.usage).toBeNull();
    expect(wire.percent).toBeNull();
    expect(wire.absence).toBe("not-collected");
  });

  it("a usage without a limit still reports usage and no percent", () => {
    const r = reading({ kind: "network", unit: "bytesPerSecond", usage: 4096, limitKind: "none" });

    expect(r.usage).toBe(4096);
    expect(r.limit).toBeNull();
    expect(r.percent).toBeNull();
    expect(r.limitKind).toBe("none");
  });
});
