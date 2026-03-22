import { describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Service health transition detection
// ---------------------------------------------------------------------------
// These tests verify the transition logic in isolation, mirroring the
// checkServiceHealth behaviour from lib/system-alerts/monitor.ts without
// requiring DB or network access.

type ServiceStatus = "healthy" | "unhealthy" | "unconfigured";

type ServiceSnapshot = {
  name: string;
  status: ServiceStatus;
  description: string;
  latencyMs?: number;
};

// Extracted transition logic (mirrors monitor.ts, testable without side-effects)
function detectTransitions(
  current: ServiceSnapshot[],
  previous: Map<string, ServiceStatus>
): string[] {
  const triggered: string[] = [];
  for (const svc of current) {
    const prev = previous.get(svc.name);
    const isDown = svc.status === "unhealthy";
    // Alert only on the healthy→unhealthy (or unknown→unhealthy) transition
    if (isDown && prev !== "unhealthy") {
      triggered.push(svc.name);
    }
  }
  return triggered;
}

describe("service health transition detection", () => {
  let previousHealth: Map<string, ServiceStatus>;

  beforeEach(() => {
    previousHealth = new Map();
  });

  it("triggers an alert on healthy → unhealthy transition", () => {
    previousHealth.set("postgres", "healthy");

    const current: ServiceSnapshot[] = [
      { name: "postgres", status: "unhealthy", description: "PostgreSQL" },
    ];

    const triggered = detectTransitions(current, previousHealth);
    expect(triggered).toContain("postgres");
  });

  it("does not trigger when already unhealthy (unhealthy → unhealthy)", () => {
    previousHealth.set("postgres", "unhealthy");

    const current: ServiceSnapshot[] = [
      { name: "postgres", status: "unhealthy", description: "PostgreSQL" },
    ];

    const triggered = detectTransitions(current, previousHealth);
    expect(triggered).toHaveLength(0);
  });

  it("does not trigger when service recovers (unhealthy → healthy)", () => {
    previousHealth.set("postgres", "unhealthy");

    const current: ServiceSnapshot[] = [
      { name: "postgres", status: "healthy", description: "PostgreSQL" },
    ];

    const triggered = detectTransitions(current, previousHealth);
    expect(triggered).toHaveLength(0);
  });

  it("triggers on first observation of unhealthy (no previous state)", () => {
    // No previous state — treat as transition since prev !== "unhealthy"
    const current: ServiceSnapshot[] = [
      { name: "redis", status: "unhealthy", description: "Redis" },
    ];

    const triggered = detectTransitions(current, previousHealth);
    expect(triggered).toContain("redis");
  });

  it("does not trigger for healthy service with no previous state", () => {
    const current: ServiceSnapshot[] = [
      { name: "redis", status: "healthy", description: "Redis" },
    ];

    const triggered = detectTransitions(current, previousHealth);
    expect(triggered).toHaveLength(0);
  });

  it("does not trigger for unconfigured service", () => {
    previousHealth.set("smtp", "unconfigured");

    const current: ServiceSnapshot[] = [
      { name: "smtp", status: "unconfigured", description: "SMTP" },
    ];

    const triggered = detectTransitions(current, previousHealth);
    expect(triggered).toHaveLength(0);
  });

  it("handles multiple services with mixed transitions correctly", () => {
    previousHealth.set("postgres", "healthy");
    previousHealth.set("redis", "unhealthy");
    previousHealth.set("smtp", "healthy");

    const current: ServiceSnapshot[] = [
      { name: "postgres", status: "unhealthy", description: "DB" }, // transition → alert
      { name: "redis", status: "unhealthy", description: "Cache" },  // no change
      { name: "smtp", status: "healthy", description: "Mail" },       // recovery, no alert
    ];

    const triggered = detectTransitions(current, previousHealth);
    expect(triggered).toEqual(["postgres"]);
  });
});

// ---------------------------------------------------------------------------
// Disk threshold ordering — highest severity fires first
// ---------------------------------------------------------------------------

type DiskResource = {
  percent: number;
};

function highestApplicableThreshold(
  disk: DiskResource,
  previousPercent: number | null,
  thresholds: number[] // already sorted descending
): number | null {
  for (const threshold of thresholds) {
    if (
      disk.percent >= threshold &&
      (previousPercent === null || previousPercent < threshold)
    ) {
      return threshold;
    }
  }
  return null;
}

describe("disk threshold ordering", () => {
  const THRESHOLDS = [95, 90, 85]; // descending — mirrors monitor.ts

  it("fires the 95% threshold first when disk jumps from 0% to 97%", () => {
    const result = highestApplicableThreshold(
      { percent: 97 },
      0,
      THRESHOLDS
    );
    expect(result).toBe(95);
  });

  it("fires the 90% threshold when disk is at 92% and previous was below 90%", () => {
    const result = highestApplicableThreshold(
      { percent: 92 },
      80,
      THRESHOLDS
    );
    expect(result).toBe(90);
  });

  it("fires the 85% threshold when disk is at 87% and previous was below 85%", () => {
    const result = highestApplicableThreshold(
      { percent: 87 },
      70,
      THRESHOLDS
    );
    expect(result).toBe(85);
  });

  it("does not re-fire the 95% threshold when disk stays above it", () => {
    const result = highestApplicableThreshold(
      { percent: 97 },
      96, // previousPercent already above 95
      THRESHOLDS
    );
    expect(result).toBeNull();
  });

  it("does not fire any threshold when disk is below 85%", () => {
    const result = highestApplicableThreshold(
      { percent: 80 },
      70,
      THRESHOLDS
    );
    expect(result).toBeNull();
  });

  it("fires on first tick when previousPercent is null and disk exceeds threshold", () => {
    const result = highestApplicableThreshold(
      { percent: 91 },
      null,
      THRESHOLDS
    );
    expect(result).toBe(90);
  });

  it("when crossing multiple thresholds at once, only the highest fires", () => {
    // Jump from 60% to 97% — crosses 85, 90, and 95 all at once
    // Only 95 should fire (break after first match)
    const result = highestApplicableThreshold(
      { percent: 97 },
      60,
      THRESHOLDS
    );
    expect(result).toBe(95);
  });
});

// ---------------------------------------------------------------------------
// Tick overlap guard
// ---------------------------------------------------------------------------

describe("tick overlap guard", () => {
  it("prevents concurrent ticks using an in-progress flag", async () => {
    let running = false;
    let executionCount = 0;

    async function safeTick(): Promise<void> {
      if (running) return; // overlap guard
      running = true;
      try {
        executionCount++;
        // Simulate async work
        await Promise.resolve();
      } finally {
        running = false;
      }
    }

    // Fire two concurrent ticks — the second should be a no-op
    await Promise.all([safeTick(), safeTick()]);
    expect(executionCount).toBe(1);
  });

  it("allows a second tick after the first completes", async () => {
    let running = false;
    let executionCount = 0;

    async function safeTick(): Promise<void> {
      if (running) return;
      running = true;
      try {
        executionCount++;
        await Promise.resolve();
      } finally {
        running = false;
      }
    }

    await safeTick();
    await safeTick();
    expect(executionCount).toBe(2);
  });
});
