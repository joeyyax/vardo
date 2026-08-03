import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeOnShutdown, isShuttingDown, installShutdownHandlers } from "@/lib/shutdown";
import { createSSEResponse } from "@/lib/api/sse";
import type { NextRequest } from "next/server";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

type ShutdownState = { closers: Set<() => void>; shuttingDown: boolean; installed: boolean };
const globalForShutdown = globalThis as unknown as { __vardo_shutdown?: ShutdownState };

// The module captures the state object once, so reset by mutating it, not replacing it.
function resetState() {
  const state = globalForShutdown.__vardo_shutdown!;
  state.closers.clear();
  state.shuttingDown = false;
  state.installed = false;
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
}

/** Fire the installed SIGTERM handlers without signalling the real process. */
function fireSigterm() {
  for (const listener of process.listeners("SIGTERM")) {
    (listener as () => void)();
  }
}

function fakeRequest(): NextRequest {
  return { signal: new AbortController().signal } as unknown as NextRequest;
}

// Fake timers keep the drain deadline from calling process.exit mid-run.
beforeEach(() => {
  vi.useFakeTimers();
  resetState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shutdown registry", () => {
  it("runs registered closers on SIGTERM", () => {
    const closer = vi.fn();
    closeOnShutdown(closer);

    fireSigterm();

    expect(closer).toHaveBeenCalledOnce();
    expect(isShuttingDown()).toBe(true);
  });

  it("registers a handler on first use", () => {
    closeOnShutdown(() => {});
    expect(process.listenerCount("SIGTERM")).toBe(1);
  });

  it("installs handlers only once", () => {
    installShutdownHandlers();
    installShutdownHandlers();
    expect(process.listenerCount("SIGTERM")).toBe(1);
  });

  it("does not run a closer that unregistered first", () => {
    const closer = vi.fn();
    const unregister = closeOnShutdown(closer);
    unregister();

    fireSigterm();

    expect(closer).not.toHaveBeenCalled();
  });

  it("runs a closer immediately when shutdown already started", () => {
    installShutdownHandlers();
    fireSigterm();

    const closer = vi.fn();
    closeOnShutdown(closer);

    expect(closer).toHaveBeenCalledOnce();
  });

  it("keeps the registry on globalThis so bundled copies share it", () => {
    closeOnShutdown(() => {});
    expect(globalForShutdown.__vardo_shutdown!.closers.size).toBe(1);
  });

  it("keeps going when a closer throws", () => {
    const second = vi.fn();
    closeOnShutdown(() => { throw new Error("boom"); });
    closeOnShutdown(second);

    fireSigterm();

    expect(second).toHaveBeenCalledOnce();
  });
});

describe("createSSEResponse shutdown handling", () => {
  it("closes the stream on SIGTERM instead of holding the connection", async () => {
    const response = createSSEResponse(fakeRequest(), () => new Promise(() => {}));
    const reader = response.body!.getReader();

    fireSigterm();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: shutdown");
    expect((await reader.read()).done).toBe(true);
  });

  it("unregisters when the handler finishes normally", async () => {
    createSSEResponse(fakeRequest(), async () => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(globalForShutdown.__vardo_shutdown!.closers.size).toBe(0);
  });
});
