// Next build workers evaluate every module reachable from a route bundle.
// Shutdown wiring at module scope therefore lands in throwaway build processes
// and registers cleanup for a monitor that was never started.

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const shutdown = vi.hoisted(() => ({
  closers: [] as (() => void)[],
  unregister: vi.fn(),
}));

vi.mock("@/lib/shutdown", () => ({
  closeOnShutdown: (closer: () => void) => {
    shutdown.closers.push(closer);
    return shutdown.unregister;
  },
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
  "@/lib/stream/consumer",
];

afterEach(() => {
  vi.useRealTimers();
  shutdown.closers.length = 0;
  shutdown.unregister.mockClear();
});

describe("monitor shutdown handlers", () => {
  it.each(MODULES)("%s wires no shutdown on import", async (specifier) => {
    const before = listenerCounts();
    await import(specifier);
    expect(listenerCounts()).toEqual(before);
    expect(shutdown.closers).toHaveLength(0);
  });

  it("registers the reconciler's stop only once it starts", async () => {
    vi.useFakeTimers();
    const { startStatusReconciler, stopStatusReconciler } = await import(
      "@/lib/docker/status-reconcile"
    );

    expect(shutdown.closers).toHaveLength(0);
    startStatusReconciler();
    expect(shutdown.closers).toEqual([stopStatusReconciler]);

    stopStatusReconciler();
    expect(shutdown.unregister).toHaveBeenCalledTimes(1);
  });

  it("stops the reconciler when the registry drains it", async () => {
    vi.useFakeTimers();
    const { startStatusReconciler, stopStatusReconciler } = await import(
      "@/lib/docker/status-reconcile"
    );

    startStatusReconciler();
    startStatusReconciler();
    expect(shutdown.closers).toHaveLength(1);

    // Only a stopped reconciler registers again — a running one is a no-op.
    shutdown.closers[0]();
    startStatusReconciler();
    expect(shutdown.closers).toHaveLength(2);

    stopStatusReconciler();
  });
});
