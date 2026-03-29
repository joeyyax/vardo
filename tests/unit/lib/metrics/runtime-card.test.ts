import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// General settings — runtime card fetch logic
// ---------------------------------------------------------------------------
// The runtime card in GeneralSettings fetches /api/v1/admin/health and
// renders Node.js version, Next.js version, uptime, and memory RSS when
// data.runtime is present. On fetch error (network failure or non-ok
// response) it silently falls back, leaving runtime as null so the card
// is never rendered.
//
// These tests mirror the fetch logic from general-settings.tsx, following
// the same extracted-function pattern used elsewhere in this suite.
// ---------------------------------------------------------------------------

type RuntimeInfo = {
  nodeVersion: string;
  nextVersion: string;
  uptime: number;
  memoryUsage: number;
};

type FetchLike = () => Promise<Response>;

async function fetchRuntimeInfo(
  fetchImpl: FetchLike,
): Promise<RuntimeInfo | null> {
  try {
    const res = await fetchImpl();
    if (!res.ok) return null;
    const data = (await res.json()) as { runtime?: RuntimeInfo };
    if (data.runtime) return data.runtime;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("runtime card — fetch error path", () => {
  it("returns null when fetch throws a network error", async () => {
    const failingFetch = vi
      .fn()
      .mockRejectedValue(new Error("Network error")) as unknown as FetchLike;

    const result = await fetchRuntimeInfo(failingFetch);

    expect(result).toBeNull();
  });

  it("returns null when the response is not ok", async () => {
    const errorResponse = {
      ok: false,
      json: vi.fn(),
    } as unknown as Response;
    const fetchWithError = vi
      .fn()
      .mockResolvedValue(errorResponse) as unknown as FetchLike;

    const result = await fetchRuntimeInfo(fetchWithError);

    expect(result).toBeNull();
    expect(errorResponse.json).not.toHaveBeenCalled();
  });

  it("returns null when the response body lacks a runtime field", async () => {
    const emptyResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    } as unknown as Response;
    const fetchWithEmpty = vi
      .fn()
      .mockResolvedValue(emptyResponse) as unknown as FetchLike;

    const result = await fetchRuntimeInfo(fetchWithEmpty);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("runtime card — success path", () => {
  it("returns runtime info when the response is ok and runtime is present", async () => {
    const runtime: RuntimeInfo = {
      nodeVersion: "v20.11.0",
      nextVersion: "15.1.0",
      uptime: 3661,
      memoryUsage: 52428800,
    };
    const successResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ runtime }),
    } as unknown as Response;
    const fetchWithRuntime = vi
      .fn()
      .mockResolvedValue(successResponse) as unknown as FetchLike;

    const result = await fetchRuntimeInfo(fetchWithRuntime);

    expect(result).toEqual(runtime);
  });
});
