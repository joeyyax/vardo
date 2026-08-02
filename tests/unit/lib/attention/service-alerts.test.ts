import { describe, it, expect } from "vitest";

import { selectActiveServiceAlerts } from "@/lib/attention/service-alerts";

const NOW = new Date("2026-08-01T12:00:00Z");

function minutesAgo(n: number) {
  return new Date(NOW.getTime() - n * 60_000).toISOString();
}

describe("selectActiveServiceAlerts", () => {
  it("reports a service that alerted moments ago", () => {
    const active = selectActiveServiceAlerts(
      { "service-degraded:Loki": { lastFired: minutesAgo(2), count: 40 } },
      NOW,
    );
    expect(active.map((a) => a.name)).toEqual(["Loki"]);
  });

  // Recovery clears the entry, so an hours-old entry is a service still down.
  it("keeps an entry from earlier in an ongoing outage", () => {
    const active = selectActiveServiceAlerts(
      { "service-degraded:Loki": { lastFired: minutesAgo(120), count: 2 } },
      NOW,
    );
    expect(active.map((a) => a.name)).toEqual(["Loki"]);
  });

  // The window only catches a monitor that died mid-outage. A live outage
  // re-alerts daily, so the guard has to outlast that.
  it("keeps an alert just inside the window and drops one just outside", () => {
    const inside = selectActiveServiceAlerts(
      { "service-degraded:Loki": { lastFired: minutesAgo(25 * 60), count: 5 } },
      NOW,
    );
    const outside = selectActiveServiceAlerts(
      { "service-degraded:Loki": { lastFired: minutesAgo(27 * 60), count: 5 } },
      NOW,
    );
    expect(inside.map((a) => a.name)).toEqual(["Loki"]);
    expect(outside).toEqual([]);
  });

  it("ignores alert types that are not service-degraded", () => {
    const active = selectActiveServiceAlerts(
      {
        "disk-space:/": { lastFired: minutesAgo(1), count: 3 },
        "cert-expiring:auth.example.com": { lastFired: minutesAgo(1), count: 1 },
      },
      NOW,
    );
    expect(active).toEqual([]);
  });

  // Locale order, so a lowercase leading letter does not sort to the end.
  it("sorts by name so the row order is stable between loads", () => {
    const active = selectActiveServiceAlerts(
      {
        "service-degraded:Traefik": { lastFired: minutesAgo(1), count: 1 },
        "service-degraded:cAdvisor": { lastFired: minutesAgo(1), count: 1 },
        "service-degraded:Loki": { lastFired: minutesAgo(1), count: 1 },
      },
      NOW,
    );
    expect(active.map((a) => a.name)).toEqual(["cAdvisor", "Loki", "Traefik"]);
  });

  it("survives a malformed or empty ledger", () => {
    expect(selectActiveServiceAlerts(null, NOW)).toEqual([]);
    expect(selectActiveServiceAlerts({}, NOW)).toEqual([]);
    expect(
      selectActiveServiceAlerts({ "service-degraded:": { lastFired: minutesAgo(1), count: 1 } }, NOW),
    ).toEqual([]);
    expect(
      selectActiveServiceAlerts({ "service-degraded:X": { lastFired: "nonsense", count: 1 } }, NOW),
    ).toEqual([]);
  });
});
