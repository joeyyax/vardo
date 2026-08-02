import { describe, it, expect } from "vitest";

import { seriesToPoints } from "@/lib/metrics/aggregate";

// Disk is sampled less often than CPU, so most buckets have no disk reading.
describe("seriesToPoints disk carry-forward", () => {
  it("carries the last reading through buckets with no sample", () => {
    const points = seriesToPoints({
      cpu: [[1, 10], [2, 12], [3, 14], [4, 16]],
      disk: [[1, 500], [3, 520]],
    });
    expect(points.map((p) => p.diskTotal)).toEqual([500, 500, 520, 520]);
  });

  it("reports zero until the first reading arrives", () => {
    const points = seriesToPoints({
      cpu: [[1, 10], [2, 12], [3, 14]],
      disk: [[3, 700]],
    });
    expect(points.map((p) => p.diskTotal)).toEqual([0, 0, 700]);
  });

  // A genuine zero is a real reading and must not be replaced by the last value.
  it("honors an explicit zero", () => {
    const points = seriesToPoints({
      cpu: [[1, 10], [2, 12]],
      disk: [[1, 900], [2, 0]],
    });
    expect(points.map((p) => p.diskTotal)).toEqual([900, 0]);
  });

  it("reports zero throughout when no disk series is given", () => {
    const points = seriesToPoints({ cpu: [[1, 10], [2, 12]] });
    expect(points.map((p) => p.diskTotal)).toEqual([0, 0]);
  });
});
