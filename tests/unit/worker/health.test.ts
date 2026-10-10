import { describe, expect, it } from "vitest";
import { healthVerdict, type HealthInput } from "@/worker/health";

const healthy: HealthInput = { booted: true, draining: false, database: true, redis: true, staleLoops: [] };

describe("worker /healthz", () => {
  it("is 200 ok when booted with the database and Redis up and no stale critical loop", () => {
    expect(healthVerdict(healthy)).toEqual({ code: 200, status: "ok" });
  });

  it("is 503 until booted", () => {
    expect(healthVerdict({ ...healthy, booted: false })).toEqual({ code: 503, status: "booting" });
  });

  it("is 503 with the database unreachable or a critical loop stale", () => {
    expect(healthVerdict({ ...healthy, database: false }).code).toBe(503);
    expect(healthVerdict({ ...healthy, staleLoops: ["backup-tick"] })).toEqual({ code: 503, status: "unhealthy" });
  });

  it("only degrades with Redis down", () => {
    expect(healthVerdict({ ...healthy, redis: false })).toEqual({ code: 200, status: "degraded" });
  });

  it("reads 200 draining while draining, so nothing restarts it mid-drain", () => {
    expect(healthVerdict({ ...healthy, draining: true, database: false, staleLoops: ["deploy-sweep"] })).toEqual({ code: 200, status: "draining" });
  });
});
