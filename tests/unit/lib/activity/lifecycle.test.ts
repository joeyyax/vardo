// What one operator action leaves behind. The row is the only record a restart
// ever produces, so what it omits is gone.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { recordActivityMock, appsFindFirst, logError } = vi.hoisted(() => ({
  recordActivityMock: vi.fn(),
  appsFindFirst: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/activity/record", () => ({ recordActivity: recordActivityMock }));
vi.mock("@/lib/db", () => ({ db: { query: { apps: { findFirst: appsFindFirst } } } }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ error: logError, info: vi.fn(), warn: vi.fn() }) },
}));

import { recordLifecycle } from "@/lib/activity/lifecycle";

const ORG = "org-1";
const app = { id: "app-1", parentAppId: null, composeService: null };

/** Metadata of the nth recorded row. */
function metadata(call = 0): Record<string, unknown> {
  return recordActivityMock.mock.calls[call][0].metadata;
}

beforeEach(() => {
  vi.clearAllMocks();
  appsFindFirst.mockResolvedValue(undefined);
});

describe("recordLifecycle", () => {
  it("carries the outcome, the pending config and the span", async () => {
    await recordLifecycle({
      organizationId: ORG,
      app: { ...app, needsRedeploy: true },
      kind: "restarted",
      status: "error",
      durationMs: 1200,
    });

    expect(metadata()).toEqual({
      scope: "app",
      status: "error",
      needsRedeploy: true,
      durationMs: 1200,
    });
  });

  it("writes no outcome when Docker could not be read", async () => {
    await recordLifecycle({ organizationId: ORG, app, kind: "restarted", status: null });

    expect(metadata()).toEqual({ scope: "app" });
  });

  it("keeps a zero span rather than reading as unrecorded", async () => {
    await recordLifecycle({ organizationId: ORG, app, kind: "stopped", durationMs: 0 });

    expect(metadata()).toMatchObject({ durationMs: 0 });
  });

  it("still records nothing more than it was given", async () => {
    await recordLifecycle({ organizationId: ORG, app, kind: "stopped", trigger: "mcp" });

    expect(metadata()).toEqual({ scope: "app", trigger: "mcp" });
  });

  it("never turns a successful action into an error", async () => {
    recordActivityMock.mockRejectedValue(new Error("db down"));

    await expect(
      recordLifecycle({ organizationId: ORG, app, kind: "restarted", status: "active" }),
    ).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalled();
  });
});
