import { describe, it, expect } from "vitest";
import { newWatchdogEvents, describeWatchdogEvent } from "@/lib/system-alerts/watchdog-events";

const line = (o: Record<string, unknown>) => JSON.stringify(o);

describe("newWatchdogEvents", () => {
  const log = [
    line({ ts: 100, role: "traefik", container: "vardo-traefik", action: "restart", fails: 3 }),
    "{\"ts\":150,\"role\":\"console\"",
    line({ ts: 300, role: "redis", container: "vardo-redis", action: "backoff", fails: 10 }),
    line({ ts: 200, role: "console", container: "vardo-production-blue-frontend-1", action: "restart-failed", fails: 3 }),
    line({ ts: 250, role: "console", container: "x", action: "something-else", fails: 1 }),
    "",
  ].join("\n");

  it("returns events after the cursor, oldest first, skipping partial lines", () => {
    expect(newWatchdogEvents(log, 100).map((e) => [e.ts, e.action])).toEqual([
      [200, "restart-failed"],
      [300, "backoff"],
    ]);
  });

  it("returns everything from a zero cursor", () => {
    expect(newWatchdogEvents(log, 0)).toHaveLength(3);
  });

  it("returns nothing once the cursor is current", () => {
    expect(newWatchdogEvents(log, 300)).toEqual([]);
  });
});

describe("describeWatchdogEvent", () => {
  it("names the container and the check count", () => {
    const { title, message } = describeWatchdogEvent({
      ts: 0,
      role: "traefik",
      container: "vardo-traefik",
      action: "restart",
      fails: 3,
    });
    expect(title).toBe("Watchdog restarted vardo-traefik");
    expect(message).toContain("unhealthy for 3 checks");
    expect(message).toContain("1970-01-01T00:00:00.000Z");
  });
});
