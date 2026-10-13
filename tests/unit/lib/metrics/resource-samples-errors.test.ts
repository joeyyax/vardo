// A store outage reads as an error, never as "no samples".

import { describe, it, expect, vi, beforeEach } from "vitest";
import { jsonRequest, routeCtx } from "@/tests/helpers/request";

const h = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock("@/lib/metrics/ts-client", () => ({ tsRedis: { call: h.call } }));
vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: async () => ({ id: "org-1" }) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/metrics/resources-query", async () => {
  const { readSeries } = await import("@/lib/metrics/resource-samples");
  return {
    DEFAULT_WINDOW_MS: 3_600_000,
    DEFAULT_BUCKETS: 24,
    getOrgResources: async () => ({ series: await readSeries(["cpu", "memory"], 0, 1000) }),
  };
});

const { readSeries, MetricsStoreError } = await import("@/lib/metrics/resource-samples");
const route = await import("@/app/api/v1/organizations/[orgId]/resources/route");

beforeEach(() => {
  h.call.mockReset();
});

describe("readSeries", () => {
  it("throws when the store can't be read", async () => {
    h.call.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(readSeries(["cpu"], 0, 1000)).rejects.toBeInstanceOf(MetricsStoreError);
  });

  it("returns an empty list when the store has no samples", async () => {
    h.call.mockResolvedValue([]);
    expect((await readSeries(["cpu"], 0, 1000)).get("cpu")).toEqual([]);
  });
});

describe("GET /resources", () => {
  it("answers 503 during a store outage", async () => {
    h.call.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await route.GET(jsonRequest("GET", "/api/v1/organizations/org-1/resources"), routeCtx({ orgId: "org-1" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/unavailable/);
  });
});
