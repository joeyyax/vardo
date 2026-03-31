import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// getHubAddress — reads hub IP from WireGuard container, falls back to HUB_IP
// ---------------------------------------------------------------------------
// docker exec is mocked so these tests run without an actual container.

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

// HUB_IP is the fallback when docker exec fails or returns garbage
import { getHubAddress } from "@/lib/mesh/wireguard";
import { HUB_IP } from "@/lib/mesh/ip-allocator";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getHubAddress", () => {
  it("returns the IP when docker exec succeeds and output is a valid IPv4", async () => {
    mockExecFile.mockImplementation((_file: unknown, _args: unknown, callback: (err: null, result: { stdout: string }) => void) => {
      callback(null, { stdout: "10.99.0.1\n" });
    });

    const result = await getHubAddress();
    expect(result).toBe("10.99.0.1");
  });

  it("returns HUB_IP when docker exec returns garbage (invalid output)", async () => {
    mockExecFile.mockImplementation((_file: unknown, _args: unknown, callback: (err: null, result: { stdout: string }) => void) => {
      callback(null, { stdout: "not-an-ip\n" });
    });

    const result = await getHubAddress();
    expect(result).toBe(HUB_IP);
  });

  it("returns HUB_IP when docker exec returns empty output", async () => {
    mockExecFile.mockImplementation((_file: unknown, _args: unknown, callback: (err: null, result: { stdout: string }) => void) => {
      callback(null, { stdout: "\n" });
    });

    const result = await getHubAddress();
    expect(result).toBe(HUB_IP);
  });

  it("returns HUB_IP when docker exec throws (container not running)", async () => {
    mockExecFile.mockImplementation((_file: unknown, _args: unknown, callback: (err: Error) => void) => {
      callback(new Error("No such container: vardo-wireguard"));
    });

    const result = await getHubAddress();
    expect(result).toBe(HUB_IP);
  });

  it("returns HUB_IP when docker exec throws ENOENT (docker not installed)", async () => {
    mockExecFile.mockImplementation((_file: unknown, _args: unknown, callback: (err: Error) => void) => {
      callback(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    });

    const result = await getHubAddress();
    expect(result).toBe(HUB_IP);
  });
});
