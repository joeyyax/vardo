import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------

const { mockGetHooksForEvent, mockGetInternalHandler, mockFetch, mockExecFileAsync } =
  vi.hoisted(() => {
    const mockGetHooksForEvent = vi.fn();
    const mockGetInternalHandler = vi.fn();
    const mockFetch = vi.fn();
    const mockExecFileAsync = vi.fn();

    return { mockGetHooksForEvent, mockGetInternalHandler, mockFetch, mockExecFileAsync };
  });

vi.mock("@/lib/hooks/registry", () => ({
  getHooksForEvent: mockGetHooksForEvent,
  getInternalHandler: mockGetInternalHandler,
}));

vi.mock("@/lib/stream/producer", () => ({
  addDeployLog: vi.fn(async () => {}),
}));

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

// Mock child_process.execFile via promisify — the module calls promisify(execFile)
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => {
    // promisify wraps this into a promise-returning function.
    // We intercept at the promisified level below.
  },
}));

vi.mock("util", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    promisify: () => mockExecFileAsync,
  };
});

// Global fetch mock
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { executeHooks } from "@/lib/hooks/execute";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockHook = {
  id: string;
  name: string;
  type: "webhook" | "script" | "internal";
  failMode: string;
  priority: number;
  config: Record<string, unknown>;
};

function makeHook(overrides: Partial<MockHook> = {}): MockHook {
  return {
    id: "hook-1",
    name: "Test Hook",
    type: "webhook",
    failMode: "fail",
    priority: 10,
    config: { url: "https://example.com/hook" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeHooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetHooksForEvent.mockResolvedValue([]);
    mockGetInternalHandler.mockReturnValue(undefined);
  });

  // 1. No hooks registered
  describe("no hooks registered", () => {
    it("returns allowed: true with empty results", async () => {
      const result = await executeHooks("before.deploy", {});
      expect(result).toEqual({ allowed: true, results: [] });
    });
  });

  // 2. Single passing hook
  describe("single passing hook", () => {
    it("returns allowed: true when webhook responds with allow: true", async () => {
      mockGetHooksForEvent.mockResolvedValue([makeHook()]);
      mockFetch.mockResolvedValue(jsonResponse({ allow: true }));

      const result = await executeHooks("before.deploy", { appId: "app-1" });

      expect(result.allowed).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].allowed).toBe(true);
      expect(result.blockedBy).toBeUndefined();
    });
  });

  // 3. Single failing hook with failMode: "fail"
  describe("single failing hook with failMode: fail", () => {
    it("returns allowed: false with blockedBy info", async () => {
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({ failMode: "fail" }),
      ]);
      mockFetch.mockResolvedValue(jsonResponse({ allow: false, reason: "Policy violation" }));

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBeDefined();
      expect(result.blockedBy!.hookId).toBe("hook-1");
      expect(result.blockedBy!.hookName).toBe("Test Hook");
      expect(result.blockedBy!.reason).toBe("Policy violation");
    });

    it("blocks when webhook returns non-200 status", async () => {
      mockGetHooksForEvent.mockResolvedValue([makeHook({ failMode: "fail" })]);
      mockFetch.mockResolvedValue(jsonResponse({}, 500));

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(false);
      expect(result.blockedBy!.reason).toContain("Webhook returned 500");
    });

    it("blocks when webhook does not return allow: true explicitly", async () => {
      mockGetHooksForEvent.mockResolvedValue([makeHook({ failMode: "fail" })]);
      mockFetch.mockResolvedValue(jsonResponse({ status: "ok" }));

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(false);
    });
  });

  // 4. Single failing hook with failMode: "warn"
  describe("single failing hook with failMode: warn", () => {
    it("returns allowed: true despite hook failure", async () => {
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({ failMode: "warn" }),
      ]);
      mockFetch.mockResolvedValue(jsonResponse({ allow: false, reason: "Soft warning" }));

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].allowed).toBe(false);
      expect(result.blockedBy).toBeUndefined();
    });
  });

  // 5. Single failing hook with failMode: "ignore"
  describe("single failing hook with failMode: ignore", () => {
    it("returns allowed: true silently", async () => {
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({ failMode: "ignore" }),
      ]);
      mockFetch.mockResolvedValue(jsonResponse({ allow: false }));

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].allowed).toBe(false);
    });
  });

  // 6. Multiple hooks with priority ordering
  describe("multiple hooks with priority ordering", () => {
    it("runs hooks in priority order and stops at first fail-mode blocker", async () => {
      const executionOrder: string[] = [];

      mockGetHooksForEvent.mockResolvedValue([
        makeHook({ id: "hook-low", name: "Low Priority", priority: 10, failMode: "warn" }),
        makeHook({ id: "hook-high", name: "High Priority", priority: 20, failMode: "fail" }),
      ]);

      // First call (low priority, warn) — fails but continues
      // Second call (high priority, fail) — fails and blocks
      mockFetch
        .mockImplementationOnce(async () => {
          executionOrder.push("hook-low");
          return jsonResponse({ allow: false, reason: "Warning only" });
        })
        .mockImplementationOnce(async () => {
          executionOrder.push("hook-high");
          return jsonResponse({ allow: false, reason: "Blocked" });
        });

      const result = await executeHooks("before.deploy", {});

      expect(executionOrder).toEqual(["hook-low", "hook-high"]);
      expect(result.allowed).toBe(false);
      expect(result.blockedBy!.hookId).toBe("hook-high");
      expect(result.results).toHaveLength(2);
    });

    it("returns allowed when all hooks pass", async () => {
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({ id: "hook-a", name: "Hook A", priority: 1 }),
        makeHook({ id: "hook-b", name: "Hook B", priority: 2 }),
      ]);

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ allow: true }))
        .mockResolvedValueOnce(jsonResponse({ allow: true }));

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(true);
      expect(result.results).toHaveLength(2);
    });

    it("stops pipeline at first fail-mode hook and does not run subsequent hooks", async () => {
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({ id: "blocker", name: "Blocker", priority: 1, failMode: "fail" }),
        makeHook({ id: "after", name: "After Blocker", priority: 2, failMode: "fail" }),
      ]);

      mockFetch.mockResolvedValueOnce(jsonResponse({ allow: false, reason: "Nope" }));

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(false);
      expect(result.results).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // 7. Webhook hook
  describe("webhook hook execution", () => {
    it("sends POST with correct headers and body", async () => {
      const context = { appId: "app-123", branch: "main" };
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({
          config: { url: "https://hooks.example.com/check", secret: "mysecret" },
        }),
      ]);
      mockFetch.mockResolvedValue(jsonResponse({ allow: true }));

      await executeHooks("before.deploy", context);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://hooks.example.com/check");
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");
      expect(opts.headers["X-Hook-Signature-256"]).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(JSON.parse(opts.body)).toEqual(context);
    });

    it("does not include signature header when no secret is configured", async () => {
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({ config: { url: "https://hooks.example.com/check" } }),
      ]);
      mockFetch.mockResolvedValue(jsonResponse({ allow: true }));

      await executeHooks("before.deploy", {});

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["X-Hook-Signature-256"]).toBeUndefined();
    });
  });

  // 8. Script hook
  describe("script hook execution", () => {
    it("runs command via bash and returns allowed on exit 0", async () => {
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({
          type: "script",
          config: { command: "/usr/local/bin/check-policy.sh" },
        }),
      ]);
      mockExecFileAsync.mockResolvedValue({ stdout: "All checks passed", stderr: "" });

      const result = await executeHooks("before.deploy", { appId: "app-1" });

      expect(result.allowed).toBe(true);
      expect(result.results[0].allowed).toBe(true);
      expect(result.results[0].reason).toBe("All checks passed");

      // Verify bash invocation
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "bash",
        ["-c", "/usr/local/bin/check-policy.sh"],
        expect.objectContaining({
          env: expect.objectContaining({
            HOOK_CONTEXT: expect.any(String),
          }),
        }),
      );
    });

    it("returns not allowed when script exits non-zero", async () => {
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({
          type: "script",
          failMode: "fail",
          config: { command: "exit 1" },
        }),
      ]);
      mockExecFileAsync.mockRejectedValue(new Error("Command failed: exit code 1"));

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(false);
      expect(result.blockedBy!.reason).toContain("Command failed");
    });

    it("passes sanitized env without secrets", async () => {
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({ type: "script", config: { command: "echo ok" } }),
      ]);
      mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      await executeHooks("before.deploy", {});

      const env = mockExecFileAsync.mock.calls[0][2].env;
      expect(env.PATH).toBeDefined();
      expect(env.HOME).toBeDefined();
      expect(env.HOOK_CONTEXT).toBeDefined();
      // Should not leak database or encryption keys
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.ENCRYPTION_MASTER_KEY).toBeUndefined();
    });
  });

  // 9. Internal hook
  describe("internal hook execution", () => {
    it("calls registered handler and returns its result", async () => {
      const handler = vi.fn().mockResolvedValue({ allowed: true, reason: "Approved" });
      mockGetInternalHandler.mockReturnValue(handler);

      mockGetHooksForEvent.mockResolvedValue([
        makeHook({
          type: "internal",
          config: { handler: "capability-gate" },
        }),
      ]);

      const context = { appId: "app-1", capability: "gpu" };
      const result = await executeHooks("before.deploy", context);

      expect(result.allowed).toBe(true);
      expect(handler).toHaveBeenCalledWith(context);
    });

    it("returns not allowed when handler is not registered", async () => {
      mockGetInternalHandler.mockReturnValue(undefined);
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({
          type: "internal",
          failMode: "fail",
          config: { handler: "nonexistent-handler" },
        }),
      ]);

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(false);
      expect(result.blockedBy!.reason).toContain("not found");
    });

    it("treats handler exception as hook failure", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("Handler crashed"));
      mockGetInternalHandler.mockReturnValue(handler);

      mockGetHooksForEvent.mockResolvedValue([
        makeHook({
          type: "internal",
          failMode: "fail",
          config: { handler: "broken-handler" },
        }),
      ]);

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(false);
      expect(result.blockedBy!.reason).toContain("Handler crashed");
    });
  });

  // 10. Timeout handling
  describe("timeout handling", () => {
    it("treats webhook timeout as failure", async () => {
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({
          failMode: "fail",
          config: { url: "https://slow.example.com/hook", timeoutMs: 100 },
        }),
      ]);

      const abortError = new DOMException("The operation was aborted", "AbortError");
      mockFetch.mockRejectedValue(abortError);

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(false);
      expect(result.blockedBy!.reason).toContain("timed out");
    });

    it("treats script timeout as failure", async () => {
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({
          type: "script",
          failMode: "fail",
          config: { command: "sleep 999", timeoutMs: 100 },
        }),
      ]);
      mockExecFileAsync.mockRejectedValue(new Error("TIMEOUT: command timed out"));

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(false);
      expect(result.blockedBy!.reason).toContain("timed out");
    });

    it("timeout with failMode warn still allows the action", async () => {
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({
          failMode: "warn",
          config: { url: "https://slow.example.com/hook", timeoutMs: 100 },
        }),
      ]);

      const abortError = new DOMException("The operation was aborted", "AbortError");
      mockFetch.mockRejectedValue(abortError);

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(true);
      expect(result.results[0].allowed).toBe(false);
    });
  });

  // Edge cases
  describe("edge cases", () => {
    it("unknown hook type is treated as failure", async () => {
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({ type: "grpc" as "webhook", failMode: "fail", config: {} }),
      ]);

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(false);
      expect(result.blockedBy!.reason).toContain("Unknown hook type");
    });

    it("unknown failMode defaults to blocking (most restrictive)", async () => {
      mockGetHooksForEvent.mockResolvedValue([
        makeHook({ failMode: "banana" }),
      ]);
      mockFetch.mockResolvedValue(jsonResponse({ allow: false }));

      const result = await executeHooks("before.deploy", {});

      expect(result.allowed).toBe(false);
      expect(result.blockedBy).toBeDefined();
    });

    it("passes organizationId and appId to getHooksForEvent", async () => {
      mockGetHooksForEvent.mockResolvedValue([]);

      await executeHooks("before.deploy", {}, {
        organizationId: "org-1",
        appId: "app-1",
      });

      expect(mockGetHooksForEvent).toHaveBeenCalledWith("before.deploy", {
        organizationId: "org-1",
        appId: "app-1",
      });
    });

    it("includes durationMs in each hook result", async () => {
      mockGetHooksForEvent.mockResolvedValue([makeHook()]);
      mockFetch.mockResolvedValue(jsonResponse({ allow: true }));

      const result = await executeHooks("before.deploy", {});

      expect(result.results[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.results[0].durationMs).toBe("number");
    });
  });
});
