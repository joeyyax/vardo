import { describe, expect, it } from "vitest";
import { COMPOSE_DOWN_TIMEOUT } from "@/lib/docker/constants";
import { composeStopTimeout, parseComposeDuration } from "@/lib/docker/stop-timeout";

describe("parseComposeDuration", () => {
  it.each([
    ["135s", 135_000],
    ["2m", 120_000],
    ["1m30s", 90_000],
    ["500ms", 500],
    ["1h", 3_600_000],
  ])("reads %s", (value, ms) => expect(parseComposeDuration(value)).toBe(ms));

  it.each(["", "soon", "10", "10s junk"])("rejects %j", (value) => expect(parseComposeDuration(value)).toBeNull());
});

describe("composeStopTimeout", () => {
  it("waits out the longest grace period", () => {
    const services = { worker: { name: "worker", stop_grace_period: "135s" }, web: { name: "web" } };
    expect(composeStopTimeout(services)).toBe(150_000);
  });

  it("keeps the default for short or missing grace periods", () => {
    expect(composeStopTimeout({ web: { name: "web", stop_grace_period: "5s" } })).toBe(COMPOSE_DOWN_TIMEOUT);
    expect(composeStopTimeout({})).toBe(COMPOSE_DOWN_TIMEOUT);
  });
});
