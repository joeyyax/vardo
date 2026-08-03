// Next build workers evaluate every module reachable from a route bundle.
// Signal handlers registered at module scope therefore land in throwaway build
// processes and log a shutdown for a monitor that was never started.

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const SIGNALS = ["SIGTERM", "SIGINT", "exit"] as const;

function listenerCounts() {
  return SIGNALS.map((s) => process.listenerCount(s));
}

const MODULES = [
  "@/lib/docker/status-reconcile",
  "@/lib/docker/traefik-drift",
  "@/lib/docker/health-monitor",
  "@/lib/system-alerts/monitor",
];

afterEach(() => {
  vi.useRealTimers();
});

describe("monitor shutdown handlers", () => {
  it.each(MODULES)("%s adds no process listeners on import", async (specifier) => {
    const before = listenerCounts();
    await import(specifier);
    expect(listenerCounts()).toEqual(before);
  });

  it("installs handlers only once the reconciler starts", async () => {
    vi.useFakeTimers();
    const { startStatusReconciler, stopStatusReconciler } = await import(
      "@/lib/docker/status-reconcile"
    );

    const before = listenerCounts();
    startStatusReconciler();
    const after = listenerCounts();
    stopStatusReconciler();

    for (let i = 0; i < SIGNALS.length; i++) {
      expect(after[i]).toBe(before[i] + 1);
    }
  });
});
