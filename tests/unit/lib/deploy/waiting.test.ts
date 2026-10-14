// workerMissing: whether app deploys sit queued because no worker claims them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadWorkers } = vi.hoisted(() => ({ mockReadWorkers: vi.fn() }));

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/worker/presence", () => ({ readWorkers: mockReadWorkers }));

const { workerMissing } = await import("@/lib/deploy/waiting");

const now = new Date("2026-10-14T12:00:00Z");

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  mockReadWorkers.mockResolvedValue({ now, rows: [] });
});

afterEach(() => void vi.unstubAllEnvs());

describe("workerMissing", () => {
  it("is true with no worker beating, even when every loop runs in the console", async () => {
    expect(await workerMissing()).toBe(true);
    vi.stubEnv("VARDO_LOOPS_IN_WEB", "always");
    expect(await workerMissing()).toBe(true);
  });

  it("is false when a worker beats or the console runs every deploy", async () => {
    mockReadWorkers.mockResolvedValue({ now, rows: [{ heartbeatAt: new Date(now.getTime() - 5_000), drainingAt: null }] });
    expect(await workerMissing()).toBe(false);
    mockReadWorkers.mockResolvedValue({ now, rows: [] });
    vi.stubEnv("VARDO_DEPLOY_EXECUTOR", "web");
    expect(await workerMissing()).toBe(false);
  });
});
